//! The update manifest's own signature (W11.S2, research R3.2).
//!
//! tauri-plugin-updater checks the signature of each *binary*, but it trusts
//! `latest.json` itself: the version, the notes and which file to fetch
//! (CVE-2026-95625). So the release signs `latest.json` too, as a detached
//! `latest.json.sig` made with the same updater key (scripts/release-run.mjs,
//! W11.S3), and the app:
//!
//!   1. downloads `latest.json` and `latest.json.sig` itself;
//!   2. verifies the signature over the exact bytes against the build's
//!      updater public key, before reading anything in the manifest;
//!   3. reads the version from the verified bytes only, and refuses a
//!      version that isn't newer than the running one and the highest ever
//!      installed here (update_guard.rs, W10.D9);
//!   4. lets the plugin fetch the manifest again for the install, and
//!      refuses unless what the plugin got is the manifest it verified.
//!
//! The signature is Tauri's format: base64 of a minisign signature file, the
//! same as the `.sig` next to each bundle; the key is the updater key in
//! Tauri's form (base64 of a minisign public key file). The Ed25519 check is
//! the `minisign-verify` crate's (the one the plugin uses), passed in as
//! `verify`, so the rules here have no dependencies and `rustc --test
//! src/manifest_sig.rs` runs them on their own.

/// Why a manifest was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The release has no `latest.json.sig` (or it is empty).
    Unsigned,
    /// The signature or the key is not valid base64 / UTF-8, or the key is missing.
    Malformed,
    /// The signature does not verify against the updater key.
    BadSignature,
    /// The manifest is bigger than any real one.
    TooLarge,
}

impl Refusal {
    pub fn message(self) -> &'static str {
        match self {
            Refusal::Unsigned => "the update manifest has no signature (latest.json.sig): update refused",
            Refusal::Malformed => "the update manifest's signature or the updater key is malformed: update refused",
            Refusal::BadSignature => "the update manifest's signature does not verify with this build's updater key: update refused",
            Refusal::TooLarge => "the update manifest is too large: update refused",
        }
    }
}

/// No real latest.json comes near this (a few platforms, a short note).
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;

/// Where the signature of a manifest lives: next to it, with `.sig` added.
pub fn sig_url(manifest_url: &str) -> String {
    format!("{manifest_url}.sig")
}

/// Standard base64 (RFC 4648 §4), padding optional, ASCII whitespace ignored.
pub fn b64decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits, mut pad) = (0u32, 0u32, 0usize);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                pad += 1;
                continue;
            }
            b' ' | b'\t' | b'\r' | b'\n' => continue,
            _ => return None,
        };
        if pad > 0 {
            return None; // data after padding
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // Leftover bits must be zero and fewer than 6; at most two '='.
    if pad > 2 || bits >= 6 || acc != 0 {
        return None;
    }
    Some(out)
}

/// Verify `manifest` (the exact bytes downloaded) against `sig_b64` (the
/// contents of latest.json.sig, or None when it could not be fetched) and the
/// updater key `pubkey_b64`. `verify(data, signature_text, pubkey_text)` is
/// the Ed25519/minisign check. Nothing in the manifest is read before this.
pub fn verify_manifest(manifest: &[u8], sig_b64: Option<&[u8]>, pubkey_b64: &str, verify: impl Fn(&[u8], &str, &str) -> bool) -> Result<(), Refusal> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(Refusal::TooLarge);
    }
    let sig_b64 = match sig_b64 {
        Some(s) if !s.iter().all(u8::is_ascii_whitespace) => s,
        _ => return Err(Refusal::Unsigned),
    };
    let sig_b64 = std::str::from_utf8(sig_b64).map_err(|_| Refusal::Malformed)?;
    let sig_text = b64decode(sig_b64).and_then(|b| String::from_utf8(b).ok()).ok_or(Refusal::Malformed)?;
    if pubkey_b64.trim().is_empty() {
        return Err(Refusal::Malformed);
    }
    let key_text = b64decode(pubkey_b64).and_then(|b| String::from_utf8(b).ok()).ok_or(Refusal::Malformed)?;
    if verify(manifest, &sig_text, &key_text) {
        Ok(())
    } else {
        Err(Refusal::BadSignature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgVEVTVApSV1FmNkxSQ0dBOWk1M21sWWVjTzRJelQ1MVRHUHB2V3VjTlNDaDFDQk0wUVRhTG43M1k3R0ZPMwo=";

    fn b64(s: &str) -> Vec<u8> {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let b = s.as_bytes();
        let mut out = Vec::new();
        for c in b.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            out.push(A[(n >> 18) as usize & 63]);
            out.push(A[(n >> 12) as usize & 63]);
            out.push(if c.len() > 1 { A[(n >> 6) as usize & 63] } else { b'=' });
            out.push(if c.len() > 2 { A[n as usize & 63] } else { b'=' });
        }
        out
    }

    /// A stand-in for minisign: the "signature" is valid when it names the data.
    fn fake_verify(data: &[u8], sig: &str, key: &str) -> bool {
        key.contains("minisign public key") && sig == format!("signed:{}", String::from_utf8_lossy(data))
    }

    #[test]
    fn base64_round_trips_and_refuses_junk() {
        assert_eq!(b64decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64decode("aGVsbG8").unwrap(), b"hello");
        assert_eq!(b64decode("aGVs\nbG8=\n").unwrap(), b"hello");
        assert_eq!(b64decode("").unwrap(), b"");
        assert!(b64decode("aGVsbG8*").is_none());
        assert!(b64decode("aGVsbG8=x").is_none());
        assert!(b64decode("aGVsbG9=").is_none()); // non-zero leftover bits
        assert!(b64decode("a").is_none());
        assert!(String::from_utf8(b64decode(KEY).unwrap()).unwrap().starts_with("untrusted comment: minisign public key"));
    }

    #[test]
    fn a_signed_manifest_passes() {
        let m = br#"{"version":"0.3.0"}"#;
        let sig = b64(&format!("signed:{}", std::str::from_utf8(m).unwrap()));
        assert_eq!(verify_manifest(m, Some(&sig), KEY, fake_verify), Ok(()));
    }

    #[test]
    fn a_missing_or_empty_signature_is_refused() {
        let m = br#"{"version":"0.3.0"}"#;
        assert_eq!(verify_manifest(m, None, KEY, |_, _, _| true), Err(Refusal::Unsigned));
        assert_eq!(verify_manifest(m, Some(b""), KEY, |_, _, _| true), Err(Refusal::Unsigned));
        assert_eq!(verify_manifest(m, Some(b" \n"), KEY, |_, _, _| true), Err(Refusal::Unsigned));
    }

    #[test]
    fn a_corrupt_signature_is_refused() {
        let m = br#"{"version":"0.3.0"}"#;
        // Not base64 at all, or not UTF-8 inside: refused before any check runs.
        assert_eq!(verify_manifest(m, Some(b"%%%"), KEY, |_, _, _| true), Err(Refusal::Malformed));
        assert_eq!(verify_manifest(m, Some(&b64("\u{0}")[..]), KEY, |_, _, _| false), Err(Refusal::BadSignature));
        assert_eq!(verify_manifest(m, Some(b"/w=="), KEY, |_, _, _| true), Err(Refusal::Malformed)); // 0xFF: not UTF-8
        // A signature over other bytes (an old manifest's, say) does not verify.
        let other = b64("signed:{\"version\":\"0.1.0\"}");
        assert_eq!(verify_manifest(m, Some(&other), KEY, fake_verify), Err(Refusal::BadSignature));
        // One changed byte in the manifest.
        let sig = b64(&format!("signed:{}", std::str::from_utf8(m).unwrap()));
        assert_eq!(verify_manifest(br#"{"version":"0.3.1"}"#, Some(&sig), KEY, fake_verify), Err(Refusal::BadSignature));
    }

    #[test]
    fn no_key_means_no_update() {
        let m = br#"{"version":"0.3.0"}"#;
        let sig = b64(&format!("signed:{}", std::str::from_utf8(m).unwrap()));
        assert_eq!(verify_manifest(m, Some(&sig), "", |_, _, _| true), Err(Refusal::Malformed));
        assert_eq!(verify_manifest(m, Some(&sig), "not base64!", |_, _, _| true), Err(Refusal::Malformed));
    }

    #[test]
    fn nothing_is_read_from_an_oversized_manifest() {
        let big = vec![b' '; MAX_MANIFEST_BYTES + 1];
        assert_eq!(verify_manifest(&big, Some(b"x"), KEY, |_, _, _| true), Err(Refusal::TooLarge));
    }

    #[test]
    fn the_signature_sits_next_to_the_manifest() {
        assert_eq!(sig_url("https://github.com/o/r/releases/latest/download/latest.json"), "https://github.com/o/r/releases/latest/download/latest.json.sig");
    }
}
