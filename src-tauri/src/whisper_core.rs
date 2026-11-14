//! Desktop Whisper (plan W1.17): the parts of the whisper.cpp integration that
//! need nothing but `std`, so they are unit-tested without the Tauri crates
//! (`rustc --edition 2021 --test src/whisper_core.rs`).
//!
//! - SHA-256 of the model file, streamed, and a small cache of the result so
//!   a 1.6 GB file is hashed once, not on every transcription.
//! - A 16 kHz mono 16-bit WAV from raw PCM (what `whisper-cli -f` reads).
//! - The `whisper-cli` arguments, and the SRT it writes → timed segments.
//! - Where to look for the `whisper-cli` binary.

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

// ── SHA-256 (FIPS 180-4) ─────────────────────────────────────────────────

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// Streaming SHA-256.
pub struct Sha256 {
    h: [u32; 8],
    buf: [u8; 64],
    len: usize,
    total: u64,
}

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Sha256 {
            h: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buf: [0; 64],
            len: 0,
            total: 0,
        }
    }

    fn block(&mut self, b: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b2, mut c, mut d, mut e, mut f, mut g, mut h] = self.h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b2) ^ (a & c) ^ (b2 & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b2;
            b2 = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in self.h.iter_mut().zip([a, b2, c, d, e, f, g, h]) {
            *x = x.wrapping_add(y);
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total += data.len() as u64;
        if self.len > 0 {
            let take = (64 - self.len).min(data.len());
            self.buf[self.len..self.len + take].copy_from_slice(&data[..take]);
            self.len += take;
            data = &data[take..];
            if self.len < 64 {
                return; // all of `data` went into the partial block
            }
            let b = self.buf;
            self.block(&b);
            self.len = 0;
        }
        while data.len() >= 64 {
            let mut b = [0u8; 64];
            b.copy_from_slice(&data[..64]);
            self.block(&b);
            data = &data[64..];
        }
        self.buf[..data.len()].copy_from_slice(data);
        self.len = data.len();
    }

    pub fn hex(mut self) -> String {
        let bits = self.total.wrapping_mul(8);
        self.update(&[0x80]);
        while self.len != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        self.h.iter().map(|x| format!("{:08x}", x)).collect()
    }
}

/// Hex SHA-256 of a file, read in 1 MB pieces.
pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut f = File::open(path)?;
    let mut s = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        s.update(&buf[..n]);
    }
    Ok(s.hex())
}

// ── Model check ──────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ModelState {
    Missing,
    WrongSize,
    WrongChecksum,
    Ok,
}

impl ModelState {
    pub fn as_str(self) -> &'static str {
        match self {
            ModelState::Missing => "missing",
            ModelState::WrongSize => "wrong-size",
            ModelState::WrongChecksum => "wrong-checksum",
            ModelState::Ok => "ok",
        }
    }
}

/// `<model>.sha256`: "<bytes> <mtime secs> <sha256>" of the last check.
fn cache_path(model: &Path) -> PathBuf {
    let mut p = model.as_os_str().to_owned();
    p.push(".sha256");
    PathBuf::from(p)
}

fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Is `model` the pinned file? Size first (cheap), then the checksum, which
/// is hashed once and remembered for the same size and modification time.
pub fn check_model(model: &Path, bytes: u64, sha256: &str) -> ModelState {
    let meta = match std::fs::metadata(model) {
        Ok(m) if m.is_file() => m,
        _ => return ModelState::Missing,
    };
    if meta.len() != bytes {
        return ModelState::WrongSize;
    }
    let want = sha256.to_ascii_lowercase();
    let stamp = format!("{} {}", meta.len(), mtime_secs(&meta));
    if let Ok(cached) = std::fs::read_to_string(cache_path(model)) {
        if cached.trim() == format!("{} {}", stamp, want) {
            return ModelState::Ok;
        }
    }
    match sha256_file(model) {
        Ok(got) if got == want => {
            let _ = std::fs::write(cache_path(model), format!("{} {}\n", stamp, got));
            ModelState::Ok
        }
        _ => ModelState::WrongChecksum,
    }
}

// ── Audio ────────────────────────────────────────────────────────────────

pub const SAMPLE_RATE: u32 = 16_000;

/// A mono 16-bit little-endian WAV around `pcm` (16 kHz samples, LE i16).
pub fn write_wav(out: &mut impl Write, pcm: &[u8]) -> io::Result<()> {
    let data_len = (pcm.len() - pcm.len() % 2) as u32;
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data_len).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16u32.to_le_bytes())?; // fmt chunk size
    out.write_all(&1u16.to_le_bytes())?; // PCM
    out.write_all(&1u16.to_le_bytes())?; // mono
    out.write_all(&SAMPLE_RATE.to_le_bytes())?;
    out.write_all(&(SAMPLE_RATE * 2).to_le_bytes())?; // byte rate
    out.write_all(&2u16.to_le_bytes())?; // block align
    out.write_all(&16u16.to_le_bytes())?; // bits per sample
    out.write_all(b"data")?;
    out.write_all(&data_len.to_le_bytes())?;
    out.write_all(&pcm[..data_len as usize])
}

// ── whisper-cli ──────────────────────────────────────────────────────────

/// Only ISO-639-1 codes (or "auto") reach the command line.
pub fn valid_language(lang: &str) -> bool {
    lang == "auto" || (lang.len() == 2 && lang.bytes().all(|b| b.is_ascii_lowercase()))
}

/// `whisper-cli -m <model> -f <wav> -l <lang> -osrt -of <out> -np -t <threads>`:
/// the language is forced (never detected), SRT goes to `<out>.srt`.
pub fn cli_args(
    model: &Path,
    wav: &Path,
    lang: &str,
    out_prefix: &Path,
    threads: usize,
) -> Vec<String> {
    vec![
        "-m".into(),
        model.display().to_string(),
        "-f".into(),
        wav.display().to_string(),
        "-l".into(),
        lang.into(),
        "-osrt".into(),
        "-of".into(),
        out_prefix.display().to_string(),
        "-np".into(),
        "-t".into(),
        threads.max(1).to_string(),
    ]
}

#[derive(Debug, PartialEq, Clone)]
pub struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

fn srt_time(s: &str) -> Option<u64> {
    // HH:MM:SS,mmm (whisper.cpp writes a comma; accept a dot too)
    let s = s.trim();
    let (hms, ms) = s.split_once([',', '.'])?;
    let mut parts = hms.split(':');
    let h: u64 = parts.next()?.parse().ok()?;
    let m: u64 = parts.next()?.parse().ok()?;
    let sec: u64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || m >= 60 || sec >= 60 {
        return None;
    }
    let ms: u64 = ms.get(..3.min(ms.len()))?.parse().ok()?;
    Some(((h * 60 + m) * 60 + sec) * 1000 + ms)
}

/// SRT → segments, in file order; empty texts dropped, malformed cues skipped.
pub fn parse_srt(srt: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let text = srt.replace("\r\n", "\n");
    for cue in text.split("\n\n") {
        let mut lines = cue.lines().map(str::trim).filter(|l| !l.is_empty());
        let mut first = match lines.next() {
            Some(l) => l,
            None => continue,
        };
        if !first.contains("-->") {
            first = match lines.next() {
                Some(l) => l,
                None => continue,
            };
        }
        let Some((a, b)) = first.split_once("-->") else {
            continue;
        };
        let (Some(start_ms), Some(end_ms)) = (srt_time(a), srt_time(b)) else {
            continue;
        };
        let body = lines.collect::<Vec<_>>().join(" ");
        let body = body.trim();
        if body.is_empty() {
            continue;
        }
        out.push(Segment {
            start_ms,
            end_ms: end_ms.max(start_ms),
            text: body.to_string(),
        });
    }
    out
}

/// Where to look for `whisper-cli`, best first: the `LUMEN_WHISPER_CLI`
/// override, the app's own folder (`<app data>/whisper/`), then `PATH`.
pub fn cli_candidates(
    env_override: Option<&str>,
    app_data: &Path,
    path_var: Option<&str>,
) -> Vec<PathBuf> {
    let exe = if cfg!(windows) {
        "whisper-cli.exe"
    } else {
        "whisper-cli"
    };
    let mut out = Vec::new();
    if let Some(p) = env_override.filter(|p| !p.is_empty()) {
        out.push(PathBuf::from(p));
    }
    out.push(app_data.join("whisper").join(exe));
    if let Some(paths) = path_var {
        for dir in std::env::split_paths(paths) {
            out.push(dir.join(exe));
        }
    }
    out
}

pub fn find_cli(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

/// The pinned model file lives in `<app data>/whisper/`; only a plain file name is accepted.
pub fn model_path(app_data: &Path, file: &str) -> Option<PathBuf> {
    let ok = !file.is_empty()
        && file.len() <= 200
        && file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !file.starts_with('.');
    ok.then(|| app_data.join("whisper").join(file))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(s: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(s);
        h.hex()
    }

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            sha(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        let million = vec![b'a'; 1_000_000];
        assert_eq!(
            sha(&million),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn sha256_streamed_in_odd_pieces_matches() {
        let data: Vec<u8> = (0..10_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let mut h = Sha256::new();
        for piece in data.chunks(37) {
            h.update(piece);
        }
        assert_eq!(h.hex(), sha(&data));
    }

    #[test]
    fn model_check_size_checksum_and_cache() {
        let dir = std::env::temp_dir().join(format!("lumen-whisper-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("m.bin");
        assert_eq!(check_model(&f, 3, "x"), ModelState::Missing);
        std::fs::write(&f, b"abc").unwrap();
        assert_eq!(check_model(&f, 4, "x"), ModelState::WrongSize);
        assert_eq!(
            check_model(&f, 3, &"0".repeat(64)),
            ModelState::WrongChecksum
        );
        let good = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";
        assert_eq!(check_model(&f, 3, good), ModelState::Ok);
        assert!(std::fs::read_to_string(cache_path(&f))
            .unwrap()
            .ends_with(&format!("{}\n", good.to_ascii_lowercase())));
        // The cache only answers for the same size, time and checksum.
        assert_eq!(check_model(&f, 3, good), ModelState::Ok);
        assert_eq!(
            check_model(&f, 3, &"1".repeat(64)),
            ModelState::WrongChecksum
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn wav_header_is_16k_mono_16bit() {
        let mut out = Vec::new();
        write_wav(&mut out, &[1, 0, 2, 0, 3]).unwrap(); // odd byte dropped
        assert_eq!(out.len(), 44 + 4);
        assert_eq!(&out[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(out[4..8].try_into().unwrap()), 36 + 4);
        assert_eq!(u16::from_le_bytes(out[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(out[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(out[34..36].try_into().unwrap()), 16);
        assert_eq!(u32::from_le_bytes(out[40..44].try_into().unwrap()), 4);
    }

    #[test]
    fn srt_to_segments() {
        let srt = "1\r\n00:00:00,000 --> 00:00:02,500\r\n שלום לכולם.\r\n\r\n2\n00:00:02,500 --> 00:01:03,040\nהיום נדבר\nעל תקציב.\n\n3\n00:01:03,040 --> 00:01:04,000\n\n\nbad\n99:xx --> 1\n";
        assert_eq!(
            parse_srt(srt),
            vec![
                Segment {
                    start_ms: 0,
                    end_ms: 2500,
                    text: "שלום לכולם.".into()
                },
                Segment {
                    start_ms: 2500,
                    end_ms: 63_040,
                    text: "היום נדבר על תקציב.".into()
                },
            ]
        );
        assert_eq!(srt_time("01:02:03.4"), Some(3_723_004));
        assert_eq!(srt_time("00:61:00,000"), None);
    }

    #[test]
    fn arguments_force_the_language_and_srt() {
        let a = cli_args(
            Path::new("/m/ggml.bin"),
            Path::new("/t/in.wav"),
            "he",
            Path::new("/t/out"),
            0,
        );
        assert_eq!(
            a,
            [
                "-m",
                "/m/ggml.bin",
                "-f",
                "/t/in.wav",
                "-l",
                "he",
                "-osrt",
                "-of",
                "/t/out",
                "-np",
                "-t",
                "1"
            ]
        );
        assert!(valid_language("he") && valid_language("auto"));
        assert!(!valid_language("he; rm -rf") && !valid_language("HE") && !valid_language("heb"));
    }

    #[test]
    fn binary_and_model_locations() {
        let app = Path::new("/data/app");
        let c = cli_candidates(Some("/opt/w/whisper-cli"), app, Some("/usr/local/bin"));
        assert_eq!(c[0], PathBuf::from("/opt/w/whisper-cli"));
        assert!(c[1].starts_with("/data/app/whisper"));
        assert!(c[2].starts_with("/usr/local/bin"));
        assert_eq!(cli_candidates(Some(""), app, None).len(), 1);
        assert_eq!(
            model_path(app, "ggml-model.bin"),
            Some(PathBuf::from("/data/app/whisper/ggml-model.bin"))
        );
        assert_eq!(model_path(app, "../etc/passwd"), None);
        assert_eq!(model_path(app, ".hidden"), None);
        assert_eq!(model_path(app, "a/b.bin"), None);
    }
}
