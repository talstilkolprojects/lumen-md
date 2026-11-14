"""An age v1 implementation in Python (https://age-encryption.org/v1), written
from the specification and independent of Lumen's TypeScript (plan W1.7).
Only the `cryptography` package: X25519, HKDF, HMAC, scrypt, ChaCha20-Poly1305.
"""
import base64, hmac as _hmac, hashlib, os, re

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.primitives import serialization

CHUNK = 64 * 1024


class AgeError(Exception):
    pass


def b64(b):
    return base64.b64encode(b).decode().rstrip("=")


def unb64(s):
    if re.search(r"[^A-Za-z0-9+/]", s):
        raise AgeError("bad base64")
    b = base64.b64decode(s + "=" * (-len(s) % 4))
    if b64(b) != s:
        raise AgeError("non-canonical base64")
    return b


def hkdf(ikm, salt, info, n=32):
    return HKDF(algorithm=hashes.SHA256(), length=n, salt=salt, info=info).derive(ikm)


# bech32 (BIP 173)
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values):
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((b >> i) & 1) else 0
    return chk


def _hrp(h):
    return [ord(x) >> 5 for x in h] + [0] + [ord(x) & 31 for x in h]


def _convert(data, f, t, pad):
    acc = bits = 0
    out = []
    maxv = (1 << t) - 1
    for v in data:
        acc = (acc << f) | v
        bits += f
        while bits >= t:
            bits -= t
            out.append((acc >> bits) & maxv)
    if pad and bits:
        out.append((acc << (t - bits)) & maxv)
    elif not pad and (bits >= f or ((acc << (t - bits)) & maxv)):
        raise AgeError("bad padding")
    return out


def bech32_decode(s):
    s2 = s.lower()
    pos = s2.rfind("1")
    hrp, words = s2[:pos], [CHARSET.index(c) for c in s2[pos + 1:]]
    if _polymod(_hrp(hrp) + words) != 1:
        raise AgeError("bad checksum")
    return hrp, bytes(_convert(words[:-6], 5, 8, False))


def bech32_encode(hrp, data):
    words = _convert(data, 8, 5, True)
    chk = _polymod(_hrp(hrp) + words + [0] * 6) ^ 1
    return hrp + "1" + "".join(CHARSET[w] for w in words + [(chk >> 5 * (5 - i)) & 31 for i in range(6)])


def _raw_pub(key):
    if isinstance(key, X25519PrivateKey):
        key = key.public_key()
    return key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def _stanza(t, args, body):
    b = b64(body)
    lines = [b[i:i + 64] for i in range(0, len(b), 64)]
    if len(b) % 64 == 0:
        lines.append("")
    return "-> " + " ".join([t] + args) + "\n" + "\n".join(lines) + "\n"


def _nonce(i, last):
    return i.to_bytes(11, "big") + (b"\x01" if last else b"\x00")


def encrypt(plaintext, recipients=(), passphrase=None, log_n=10):
    file_key = os.urandom(16)
    stanzas = []
    if passphrase is not None:
        salt = os.urandom(16)
        key = Scrypt(salt=b"age-encryption.org/v1/scrypt" + salt, length=32, n=2 ** log_n, r=8, p=1).derive(passphrase.encode())
        stanzas.append(_stanza("scrypt", [b64(salt), str(log_n)], ChaCha20Poly1305(key).encrypt(b"\0" * 12, file_key, None)))
    for r in recipients:
        hrp, pub = bech32_decode(r)
        eph = X25519PrivateKey.generate()
        share = _raw_pub(eph)
        shared = eph.exchange(X25519PublicKey.from_public_bytes(pub))
        wrap = hkdf(shared, share + pub, b"age-encryption.org/v1/X25519")
        stanzas.append(_stanza("X25519", [b64(share)], ChaCha20Poly1305(wrap).encrypt(b"\0" * 12, file_key, None)))
    head = ("age-encryption.org/v1\n" + "".join(stanzas) + "---").encode()
    mac = _hmac.new(hkdf(file_key, b"", b"header"), head, hashlib.sha256).digest()
    nonce = os.urandom(16)
    pk = ChaCha20Poly1305(hkdf(file_key, nonce, b"payload"))
    n = max(1, -(-len(plaintext) // CHUNK))
    body = b"".join(pk.encrypt(_nonce(i, i == n - 1), plaintext[i * CHUNK:(i + 1) * CHUNK], None) for i in range(n))
    return head + b" " + b64(mac).encode() + b"\n" + nonce + body


def decrypt(data, identity=None, passphrase=None, max_log_n=20):
    lines = data.split(b"\n")
    if lines[0] != b"age-encryption.org/v1":
        raise AgeError("not age v1")
    i = 1
    stanzas = []
    while not lines[i].startswith(b"--- "):
        head = lines[i].decode()
        if not head.startswith("-> "):
            raise AgeError("malformed")
        t, *args = head[3:].split(" ")
        body = ""
        while True:
            i += 1
            line = lines[i].decode()
            body += line
            if len(line) < 64:
                break
        stanzas.append((t, args, unb64(body)))
        i += 1
    mac = unb64(lines[i][4:].decode())
    header_len = sum(len(l) + 1 for l in lines[:i]) + 3
    payload_start = sum(len(l) + 1 for l in lines[: i + 1])
    file_key = None
    if any(s[0] == "scrypt" for s in stanzas) and len(stanzas) != 1:
        raise AgeError("scrypt must be alone")
    for t, args, body in stanzas:
        try:
            if t == "scrypt" and passphrase is not None:
                salt, log_n = unb64(args[0]), int(args[1])
                if log_n > max_log_n:
                    raise AgeError("work factor too high")
                key = Scrypt(salt=b"age-encryption.org/v1/scrypt" + salt, length=32, n=2 ** log_n, r=8, p=1).derive(passphrase.encode())
                file_key = ChaCha20Poly1305(key).decrypt(b"\0" * 12, body, None)
            elif t == "X25519" and identity is not None:
                _, raw = bech32_decode(identity)
                priv = X25519PrivateKey.from_private_bytes(raw)
                share = unb64(args[0])
                shared = priv.exchange(X25519PublicKey.from_public_bytes(share))
                wrap = hkdf(shared, share + _raw_pub(priv), b"age-encryption.org/v1/X25519")
                file_key = ChaCha20Poly1305(wrap).decrypt(b"\0" * 12, body, None)
        except AgeError:
            raise
        except Exception:
            file_key = None
        if file_key:
            break
    if not file_key:
        raise AgeError("no identity matched")
    want = _hmac.new(hkdf(file_key, b"", b"header"), data[:header_len], hashlib.sha256).digest()
    if not _hmac.compare_digest(want, mac):
        raise AgeError("bad header MAC")
    nonce = data[payload_start:payload_start + 16]
    pk = ChaCha20Poly1305(hkdf(file_key, nonce, b"payload"))
    rest = data[payload_start + 16:]
    out = []
    i = 0
    while True:
        last = len(rest) <= CHUNK + 16
        piece, rest = rest[: CHUNK + 16], rest[CHUNK + 16:]
        out.append(pk.decrypt(_nonce(i, last), piece, None))
        i += 1
        if last:
            break
    return b"".join(out)


def new_identity():
    k = X25519PrivateKey.generate()
    raw = k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
    return bech32_encode("age-secret-key-", raw).upper(), bech32_encode("age", _raw_pub(k))
