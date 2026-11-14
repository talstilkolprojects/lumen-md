#!/usr/bin/env python3
"""
An independent reader of Lumen's encrypted sync format (plan W1.7), written
from docs/sync-protocol.md and nothing else of Lumen's code. It opens every
test vector in docs/sync-protocol-vectors.json and compares the result:

    python3 scripts/sync-protocol/check_vectors.py [vectors.json]

Needs only the `cryptography` package (Argon2id needs 44 or newer). Exit 0
when 100% of the vectors decode identically.
"""
import base64, hashlib, hmac, json, os, struct, sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agepy  # noqa: E402  (the independent age implementation next to this file)

import unicodedata


def b64u(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def jdump(v):
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


# ── Keys (spec §3) ─────────────────────────────────────────────────────────

def master_key(passphrase, kdf):
    pw = unicodedata.normalize("NFC", passphrase).encode()
    salt = unb64u(kdf["salt"])
    if kdf["alg"] == "pbkdf2-sha256":
        return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=kdf["iterations"]).derive(pw)
    if kdf["alg"] == "argon2id":
        return Argon2id(salt=salt, length=32, iterations=kdf["iterations"], lanes=kdf["parallelism"], memory_cost=kdf["memoryKiB"]).derive(pw)
    raise ValueError("unknown KDF " + kdf["alg"])


def subkey(secret, vault_id, purpose):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=vault_id.encode(), info=("lumen-e2ee/1/" + purpose).encode()).derive(secret)


def hmac256(key, data):
    return hmac.new(key, data, hashlib.sha256).digest()


def object_name(names_key, label):
    return b64u(hmac256(names_key, label.encode()))


# ── Sealed objects (spec §4) ───────────────────────────────────────────────

def unseal(key, vault_id, kind, name, sealed):
    if sealed[0] != 1:
        raise ValueError("unknown sealed format")
    aad = f"lumen-e2ee/1/{kind}/{vault_id}/{name}".encode()
    pt = AESGCM(key).decrypt(sealed[1:13], sealed[13:], aad)
    (n,) = struct.unpack(">I", pt[:4])
    if n > len(pt) - 4:
        raise ValueError("bad padding")
    return pt[4:4 + n]


KEYRING_PROTOCOL = 2


def keyring_open(key, field, vault_id, epoch, role):
    aad = f"lumen-e2ee-keyring/{KEYRING_PROTOCOL}/{vault_id}/{epoch}/{role}".encode()
    return AESGCM(key).decrypt(unb64u(field["n"]), unb64u(field["c"]), aad)


def keyring_digest(ring):
    """Spec §5: SHA-256 over the checkable fields, never the plaintext wraps."""
    return hashlib.sha256(jdump([ring["format"], ring["protocol"], ring["vaultId"], ring["epoch"], ring["passphrase"]["n"], ring["passphrase"]["c"], ring["sealed"]["n"], ring["sealed"]["c"], ring.get("header"), ring.get("prev")]).encode()).hexdigest()


def ordered_kdf(kdf):
    order = ["alg", "iterations", "salt"] if kdf["alg"] == "pbkdf2-sha256" else ["alg", "memoryKiB", "iterations", "parallelism", "salt"]
    return {k: kdf[k] for k in order}


def header_master(header, passphrase):
    """The master key, or None when the header's MAC doesn't verify with this passphrase (spec §2)."""
    kdf = ordered_kdf(header["kdf"])
    master = master_key(passphrase, kdf)
    mac_in = jdump([header["format"], header["protocol"], header["vaultId"], kdf]).encode()
    return master if hmac.compare_digest(hmac256(subkey(master, header["vaultId"], "header"), mac_in), unb64u(header["mac"])) else None


def open_contents(ring, secret):
    """Spec §5: protocol 2 only; the sealed part with its device list and chain."""
    if ring["protocol"] != KEYRING_PROTOCOL:
        raise ValueError("a pre-release keyring (protocol 1): refused")
    vid, epoch = ring["vaultId"], ring["epoch"]
    c = json.loads(keyring_open(subkey(secret, vid, "keyring"), ring["sealed"], vid, epoch, "sealed"))
    if not isinstance(c.get("devices"), dict):
        raise ValueError("no sealed device list: refused")
    if not c["manifest"].startswith(f"manifest/{epoch}/"):
        raise ValueError("bad manifest label")
    chain = c["chain"]
    if (c["parent"] is None) != (len(chain) == 0) or (chain and chain[-1][2] != c["parent"]):
        raise ValueError("the chain doesn't end at the parent")
    if c["rev"] > 0 and (chain[-1][0] != epoch or chain[-1][1] != c["rev"] - 1):
        raise ValueError("a same-epoch revision whose parent isn't the revision before")
    return c


def open_manifest(key, vid, name, data):
    """Spec §4: protocol 1, or 2 = frozen (with `frozen`), and this vault's id."""
    m = json.loads(unseal(key, vid, "manifest", name, data))
    if m.get("protocol") not in (1, 2) or (m.get("protocol") == 2) != ("frozen" in m):
        raise ValueError("unsupported manifest protocol")
    if m.get("vaultId") != vid:
        raise ValueError("the manifest belongs to another vault")
    return m


# ── A whole vault ──────────────────────────────────────────────────────────

def read_vault(objects, passphrase=None, device=None):
    """Returns (epoch, files, secret, manifest) at the epoch this passphrase or device opens."""
    header = json.loads(objects["lumen-e2ee-vault"])
    vid = header["vaultId"]
    ring = json.loads(objects["lumen-e2ee-keyring"]) if "lumen-e2ee-keyring" in objects else None
    if ring is not None and ring["vaultId"] != vid:
        raise ValueError("the keyring belongs to another vault")
    contents = None
    if passphrase is not None:
        master = header_master(header, passphrase)
        if master is None:
            # Spec §5, a passphrase change cut off: the keyring carries the new header.
            if ring is None or "header" not in ring:
                raise ValueError("header MAC: wrong passphrase or changed header")
            pending = json.loads(unb64u(ring["header"]))
            master = header_master(pending, passphrase)
            if master is None or pending["vaultId"] != vid:
                raise ValueError("header MAC: wrong passphrase or changed header")
        if ring is None:
            epoch, secret, older = 0, master, {}
        else:
            wrap_key = subkey(master, vid, "keyring-wrap")
            try:
                secret = keyring_open(wrap_key, ring["passphrase"], vid, ring["epoch"], "passphrase")
            except Exception:
                # The old passphrase while the change's header isn't written: `prev`, the epoch before.
                if "header" not in ring or "prev" not in ring:
                    raise ValueError("the keyring doesn't open with this passphrase")
                prev = json.loads(unb64u(ring["prev"]))
                if prev["vaultId"] != vid or prev["epoch"] != ring["epoch"] - 1:
                    raise ValueError("prev is not the epoch before")
                ring = prev
                secret = keyring_open(wrap_key, ring["passphrase"], vid, ring["epoch"], "passphrase")
            epoch = ring["epoch"]
            contents = open_contents(ring, secret)
            if "header" in ring and contents.get("header") != hashlib.sha256(unb64u(ring["header"])).hexdigest():
                raise ValueError("the pending header doesn't match the sealed part")
            if "prev" in ring and contents["parent"] != keyring_digest(json.loads(unb64u(ring["prev"]))):
                raise ValueError("prev is not this keyring's parent")
    else:
        epoch = ring["epoch"]
        wrap = ring["devices"][device["id"]]
        secret = agepy.decrypt(unb64u(wrap["wrap"]), identity=device["identity"])
        contents = open_contents(ring, secret)
        # Spec §5: a device must be on the sealed list, with this recipient, and not revoked.
        if contents["devices"].get(device["id"]) != wrap["recipient"] or any(r["device"] == device["id"] for r in contents["revoked"]):
            raise ValueError("the device is not on the sealed device list")
    older = {int(k): unb64u(v) for k, v in contents["older"].items()} if contents else {}
    if contents and older.get(epoch - 1) is None:
        raise ValueError("the keyring lacks the epoch before")
    secrets = dict(older)
    secrets[epoch] = secret
    names = subkey(secrets[0], vid, "names")
    # Spec §5: each re-keyed epoch names its own manifest object (a random label) in the sealed part.
    label = contents["manifest"] if contents else "manifest"
    mname = object_name(names, label)
    manifest = open_manifest(subkey(secret, vid, "manifest"), vid, mname, objects[mname])
    files = {}
    for path, e in manifest["files"].items():
        if e.get("deleted"):
            continue
        bname = object_name(names, f"blob\0{path}\0{e['rev']}")
        data = unseal(subkey(secrets[e.get("e", 0)], vid, "blobs"), vid, "blob", bname, objects[bname])
        if hashlib.sha256(data).hexdigest() != e["hash"]:
            raise ValueError(f"{path}: hash does not match the manifest")
        files[path] = data.decode()
    return epoch, files, secret, manifest, (keyring_digest(ring), contents["rev"]) if contents else None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "../../docs/sync-protocol-vectors.json")
    v = json.load(open(path, encoding="utf-8"))
    total = ok = 0

    def check(label, cond):
        nonlocal total, ok
        total += 1
        ok += bool(cond)
        print(("ok    " if cond else "FAIL  ") + label)

    for vault in v["vaults"]:
        objects = {n: base64.b64decode(d) for n, d in vault["objects"].items()}
        epoch, files, _, manifest, _ = read_vault(objects, passphrase=vault["passphrase"])
        check(f"{vault['name']}: epoch {epoch} with the passphrase", epoch == vault["expect"]["epoch"])
        check(f"{vault['name']}: {len(files)} files identical", files == vault["expect"]["files"])
        if vault.get("frozen"):
            check(f"{vault['name']}: the manifest is frozen for the next epoch (protocol 2)", manifest["protocol"] == 2 and manifest["frozen"]["epoch"] == epoch + 1)
        if "pending" in vault:
            pend = vault["pending"]
            e0, _, _, m0, _ = read_vault(objects, passphrase=pend["oldPassphrase"])
            check(f"{vault['name']}: the old passphrase opens epoch {e0} through prev, never the new one", e0 == pend["oldEpoch"] and sorted(m0["files"]) == sorted(pend["oldFiles"]))
        if "device" in vault:
            e2, f2, _, _, _ = read_vault(objects, device=vault["device"])
            check(f"{vault['name']}: the enrolled device opens it with its own key (age)", e2 == epoch and f2 == vault["expect"]["files"])
        try:
            read_vault(objects, passphrase=vault["passphrase"] + "x")
            check(f"{vault['name']}: a wrong passphrase is refused", False)
        except ValueError:
            check(f"{vault['name']}: a wrong passphrase is refused", True)

    for a in v["argon2id"]:
        tag = Argon2id(salt=base64.b64decode(a["salt"]), length=32, iterations=a["iterations"], lanes=a["parallelism"], memory_cost=a["memoryKiB"]).derive(base64.b64decode(a["password"]))
        check(f"argon2id m={a['memoryKiB']} t={a['iterations']} p={a['parallelism']}", base64.b64encode(tag).decode() == a["tag"])

    for a in v["age"]:
        data = base64.b64decode(a["file"])
        pt = agepy.decrypt(data, identity=a.get("identity"), passphrase=a.get("passphrase"))
        check(f"age ({'scrypt' if 'passphrase' in a else 'X25519'}, {len(pt)} bytes)", base64.b64encode(pt).decode() == a["plaintext"])

    # Spec §6 (fifth review, F1): "<prefix><epoch>:" + b64u(HMAC(pairing_N, "lumen-pair/<kind>/<v>\0" ‖ body) ‖ body),
    # the body says its kind and has exactly that kind's fields.
    fields = {
        "code": {"kind", "vaultId", "counter", "digest", "epoch", "ringRev", "ringDigest", "issuedAt", "nonce"},
        "request": {"kind", "vaultId", "epoch", "ringRev", "ringDigest", "counter", "digest", "requestedAt", "nonce"},
        "answer": {"kind", "vaultId", "request", "nonce", "counter", "digest", "epoch", "ringRev", "ringDigest", "answeredAt"},
    }
    versions = {"code": 3, "request": 2, "answer": 2}
    prefixes = {"code": "lumen-pair:3:", "request": "lumen-pair-request:2:", "answer": "lumen-pair-answer:2:"}

    def read_pairing(text, kind, epoch, key):
        """The body of a pairing message of `kind`, or None when its MAC (with that kind's label) or shape is wrong."""
        prefix = f"{prefixes[kind]}{epoch}:"
        if not text.startswith(prefix):
            return None
        raw = unb64u(text[len(prefix):])
        label = f"lumen-pair/{kind}/{versions[kind]}\0".encode()
        if len(raw) < 33 or not hmac.compare_digest(hmac256(key, label + raw[32:]), raw[:32]):
            return None
        body = json.loads(raw[32:])
        return body if body.get("kind") == kind and set(body) == fields[kind] else None

    def vault_keys(index):
        vault = v["vaults"][index]
        objects = {n: base64.b64decode(d) for n, d in vault["objects"].items()}
        vid = json.loads(objects["lumen-e2ee-vault"])["vaultId"]
        epoch, _, secret, _, ring = read_vault(objects, passphrase=vault["passphrase"])
        return vid, epoch, subkey(secret, vid, "pairing"), ring

    def ring_ok(body, epoch, ring, want):
        return body.get("epoch") == epoch and (ring is None or (body.get("ringDigest") == ring[0] and body.get("ringRev") == ring[1])) and body.get("ringDigest") == want["ring"]["digest"]

    for pv in v["pairing"]:
        vid, epoch, key, ring = vault_keys(pv["vault"])
        body = read_pairing(pv["code"], "code", epoch, key) or {}
        want = pv["body"]
        check(f"pairing code at epoch {epoch}: HMAC with the code label under that epoch's key, body and keyring anchor as stated", body.get("vaultId") == vid and body.get("counter") == want["counter"] and body.get("digest") == want["digest"] and ring_ok(body, epoch, ring, want))

    for pv in v.get("pairingTwoWay", []):
        vid, epoch, key, ring = vault_keys(pv["vault"])
        req = read_pairing(pv["request"], "request", epoch, key) or {}
        rw = pv["requestBody"]
        check(f"pairing request at epoch {epoch}: request label, nonce, manifest and keyring as stated", req.get("vaultId") == vid and req.get("nonce") == rw["nonce"] and req.get("counter") == (rw["manifest"] or {}).get("counter") and req.get("requestedAt") == rw["issuedAt"] and ring_ok(req, epoch, ring, rw))
        ans = read_pairing(pv["answer"], "answer", epoch, key) or {}
        want = pv["answerBody"]
        sha = hashlib.sha256(pv["request"].strip().encode()).hexdigest()
        check(f"pairing answer at epoch {epoch}: answer label, names the request's SHA-256 and nonce, anchors as stated", sha == rw["hash"] and ans.get("request") == sha and ans.get("nonce") == rw["nonce"] and ans.get("counter") == want["counter"] and ans.get("digest") == want["digest"] and ring_ok(ans, epoch, ring, want))
        # Reflection (F1): the request's bytes under the answer's or the code's prefix don't verify.
        tail = pv["request"][len(f"{prefixes['request']}{epoch}:"):]
        check(f"pairing request at epoch {epoch} relabelled as an answer or a code is refused", read_pairing(f"{prefixes['answer']}{epoch}:{tail}", "answer", epoch, key) is None and read_pairing(f"{prefixes['code']}{epoch}:{tail}", "code", epoch, key) is None)

    print(f"\n{ok}/{total} vectors decoded identically")
    sys.exit(0 if ok == total else 1)


if __name__ == "__main__":
    main()
