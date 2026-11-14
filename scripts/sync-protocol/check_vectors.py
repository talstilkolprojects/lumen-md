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


def keyring_open(key, field, vault_id, epoch, role):
    aad = f"lumen-e2ee-keyring/1/{vault_id}/{epoch}/{role}".encode()
    return AESGCM(key).decrypt(unb64u(field["n"]), unb64u(field["c"]), aad)


# ── A whole vault ──────────────────────────────────────────────────────────

def read_vault(objects, passphrase=None, device=None):
    header = json.loads(objects["lumen-e2ee-vault"])
    vid = header["vaultId"]
    kdf = header["kdf"]
    order = ["alg", "iterations", "salt"] if kdf["alg"] == "pbkdf2-sha256" else ["alg", "memoryKiB", "iterations", "parallelism", "salt"]
    kdf = {k: kdf[k] for k in order}
    ring = json.loads(objects["lumen-e2ee-keyring"]) if "lumen-e2ee-keyring" in objects else None
    if passphrase is not None:
        master = master_key(passphrase, kdf)
        mac_in = jdump([header["format"], header["protocol"], vid, kdf]).encode()
        if not hmac.compare_digest(hmac256(subkey(master, vid, "header"), mac_in), unb64u(header["mac"])):
            raise ValueError("header MAC: wrong passphrase or changed header")
    if ring is None:
        epoch, secret, older = 0, master, {}
    else:
        epoch = ring["epoch"]
        if passphrase is not None:
            secret = keyring_open(subkey(master, vid, "keyring-wrap"), ring["passphrase"], vid, epoch, "passphrase")
        else:
            wrap = ring["devices"][device["id"]]
            secret = agepy.decrypt(unb64u(wrap["wrap"]), identity=device["identity"])
        contents = json.loads(keyring_open(subkey(secret, vid, "keyring"), ring["sealed"], vid, epoch, "sealed"))
        older = {int(k): unb64u(v) for k, v in contents["older"].items()}
        # Spec §5: the enrolled devices are the sealed list; a device must be on it.
        if device is not None and "devices" in contents and contents["devices"].get(device["id"]) != wrap["recipient"]:
            raise ValueError("the device is not on the sealed device list")
    secrets = dict(older)
    secrets[epoch] = secret
    names = subkey(secrets[0], vid, "names")
    # Spec §5: each re-keyed epoch names its own manifest object in the sealed part.
    label = contents.get("manifest", "manifest") if ring is not None else "manifest"
    mname = object_name(names, label)
    manifest = json.loads(unseal(subkey(secret, vid, "manifest"), vid, "manifest", mname, objects[mname]))
    files = {}
    for path, e in manifest["files"].items():
        if e.get("deleted"):
            continue
        bname = object_name(names, f"blob\0{path}\0{e['rev']}")
        data = unseal(subkey(secrets[e.get("e", 0)], vid, "blobs"), vid, "blob", bname, objects[bname])
        if hashlib.sha256(data).hexdigest() != e["hash"]:
            raise ValueError(f"{path}: hash does not match the manifest")
        files[path] = data.decode()
    return epoch, files, names


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
        epoch, files, _ = read_vault(objects, passphrase=vault["passphrase"])
        check(f"{vault['name']}: epoch {epoch} with the passphrase", epoch == vault["expect"]["epoch"])
        check(f"{vault['name']}: {len(files)} files identical", files == vault["expect"]["files"])
        if "device" in vault:
            e2, f2, _ = read_vault(objects, device=vault["device"])
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

    pv = v["pairing"]
    vault = v["vaults"][pv["vault"]]
    objects = {n: base64.b64decode(d) for n, d in vault["objects"].items()}
    header = json.loads(objects["lumen-e2ee-vault"])
    epoch, _, _ = read_vault(objects, passphrase=vault["passphrase"])
    kdf = header["kdf"]
    order = ["alg", "iterations", "salt"] if kdf["alg"] == "pbkdf2-sha256" else ["alg", "memoryKiB", "iterations", "parallelism", "salt"]
    master = master_key(vault["passphrase"], {k: kdf[k] for k in order})
    raw = unb64u(pv["code"][len("lumen-pair:1:"):])
    body = json.loads(raw[32:])
    check("pairing code: HMAC verifies, body as stated", hmac.compare_digest(hmac256(subkey(master, header["vaultId"], "pairing"), raw[32:]), raw[:32]) and body["counter"] == pv["body"]["counter"] and body["digest"] == pv["body"]["digest"])

    print(f"\n{ok}/{total} vectors decoded identically")
    sys.exit(0 if ok == total else 1)


if __name__ == "__main__":
    main()
