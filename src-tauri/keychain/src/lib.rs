//! OS keychain access for Lumen's secrets (T36, plan 2.5): the macOS Keychain
//! and the Windows Credential Manager, through the `keyring` crate. Other
//! platforms report the keychain as unavailable, and the app keeps its
//! WebCrypto store there.

/// The service name every Lumen secret is stored under.
pub const SERVICE: &str = "app.lumen.secrets";

/// Does this platform have a keychain the app uses?
pub fn available() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

/// Characters per stored entry. The Windows Credential Manager caps a
/// credential blob at 5 × 512 bytes, and keyring stores the password as
/// UTF-16 there, so a value longer than this (a Supabase session with its
/// user metadata easily is) is split over several entries (plan 2.5).
pub const CHUNK_CHARS: usize = 512;
const HEADER: &str = "lumen-keychain-chunks:";

/// The parts of a value are written under a generation of their own
/// (`name#g<gen>.<i>`), and the header `lumen-keychain-chunks:<gen>:<n>` is
/// switched to them only after every part is stored. A failed write leaves
/// the old header pointing at the old, untouched parts (plan 2.5).
fn chunk_name(name: &str, gen: u64, i: usize) -> String {
    format!("{name}#g{gen}.{i}")
}

/// The store the chunking is built on: one entry per name.
trait Backend {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String>;
}

/// Where a chunked value's parts live.
#[derive(Clone, Copy)]
struct Chunks {
    gen: u64,
    count: usize,
}

impl Chunks {
    fn names(self, name: &str) -> impl Iterator<Item = String> + '_ {
        (1..=self.count).map(move |i| chunk_name(name, self.gen, i))
    }
}

fn parse_header(v: &str) -> Option<Chunks> {
    let (gen, count) = v.strip_prefix(HEADER)?.split_once(':')?;
    Some(Chunks {
        gen: gen.parse().ok()?,
        count: count.parse().ok()?,
    })
}

fn get_with(b: &dyn Backend, name: &str) -> Result<Option<String>, String> {
    let Some(v) = b.get(name)? else {
        return Ok(None);
    };
    let Some(c) = parse_header(&v) else {
        return Ok(Some(v));
    };
    let mut out = String::new();
    for (i, part_name) in c.names(name).enumerate() {
        match b.get(&part_name)? {
            Some(part) => out.push_str(&part),
            None => return Err(format!("{name}: chunk {} of {} is missing", i + 1, c.count)),
        }
    }
    Ok(Some(out))
}

/// Delete parts, ignoring failures: they are only reachable through a header
/// that no longer points at them, and a leftover never changes what is read.
fn remove_parts(b: &dyn Backend, name: &str, c: Chunks) {
    for part_name in c.names(name) {
        let _ = b.set(&part_name, None);
    }
}

fn set_with(b: &dyn Backend, name: &str, value: Option<&str>) -> Result<(), String> {
    let old = b.get(name)?.as_deref().and_then(parse_header);
    match value {
        None => b.set(name, None)?,
        Some(v) if v.chars().count() <= CHUNK_CHARS && !v.starts_with(HEADER) => {
            b.set(name, Some(v))?
        }
        Some(v) => {
            let chars: Vec<char> = v.chars().collect();
            let parts: Vec<String> = chars
                .chunks(CHUNK_CHARS)
                .map(|c| c.iter().collect())
                .collect();
            // A generation the current header does not point at, so no part
            // the stored value is read from is ever overwritten.
            let new = Chunks {
                gen: old.map_or(1, |c| c.gen.wrapping_add(1)),
                count: parts.len(),
            };
            let staged = new
                .names(name)
                .zip(&parts)
                .try_for_each(|(n, p)| b.set(&n, Some(p)));
            // The header last: only now does a reader see the new parts.
            if let Err(e) = staged
                .and_then(|()| b.set(name, Some(&format!("{HEADER}{}:{}", new.gen, new.count))))
            {
                remove_parts(b, name, new);
                return Err(e);
            }
        }
    }
    // The parts of the value that was replaced.
    if let Some(c) = old {
        remove_parts(b, name, c);
    }
    Ok(())
}

/// The OS keychain under one service name.
struct Os<'a>(&'a str);

impl Backend for Os<'_> {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            match keyring::Entry::new(self.0, name)
                .map_err(|e| e.to_string())?
                .get_password()
            {
                Ok(v) => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (self.0, name);
            Err("keychain unavailable on this platform".into())
        }
    }

    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let e = keyring::Entry::new(self.0, name).map_err(|e| e.to_string())?;
            match value {
                Some(v) => e.set_password(v).map_err(|e| e.to_string()),
                None => match e.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(err) => Err(err.to_string()),
                },
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (self.0, name, value);
            Err("keychain unavailable on this platform".into())
        }
    }
}

/// One secret, or `None` when there is no entry.
pub fn get(service: &str, name: &str) -> Result<Option<String>, String> {
    get_with(&Os(service), name)
}

/// Store one secret, or with `None` delete it (deleting a missing one is fine).
/// A value over [`CHUNK_CHARS`] is split over several entries.
pub fn set(service: &str, name: &str, value: Option<&str>) -> Result<(), String> {
    set_with(&Os(service), name, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// An in-memory backend with the Windows size limit, so the chunking is
    /// tested on every platform.
    /// `fail_after`: how many more writes succeed before every write fails.
    struct Mem(
        RefCell<HashMap<String, String>>,
        std::cell::Cell<Option<usize>>,
    );
    fn mem() -> Mem {
        Mem(RefCell::new(HashMap::new()), std::cell::Cell::new(None))
    }
    impl Backend for Mem {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(name).cloned())
        }
        fn set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
            if let Some(n) = self.1.get() {
                if n == 0 {
                    return Err("keychain write failed".into());
                }
                self.1.set(Some(n - 1));
            }
            match value {
                Some(v) if v.encode_utf16().count() * 2 > 2560 => {
                    Err("blob over 2560 bytes".into())
                }
                Some(v) => {
                    self.0.borrow_mut().insert(name.into(), v.into());
                    Ok(())
                }
                None => {
                    self.0.borrow_mut().remove(name);
                    Ok(())
                }
            }
        }
    }

    #[test]
    fn long_values_are_chunked_and_cleaned_up() {
        let m = mem();
        let session = format!(
            r#"{{"access_token":"{}","user":{{"name":"טל","meta":"{}"}}}}"#,
            "a".repeat(1200),
            "m".repeat(2500)
        );
        set_with(&m, "sb-proj-auth-token", Some(&session)).unwrap();
        assert_eq!(
            get_with(&m, "sb-proj-auth-token").unwrap().as_deref(),
            Some(session.as_str())
        );
        assert!(m.0.borrow().len() > 2);
        // A shorter value replaces it and the stale parts go.
        set_with(&m, "sb-proj-auth-token", Some("short")).unwrap();
        assert_eq!(
            get_with(&m, "sb-proj-auth-token").unwrap().as_deref(),
            Some("short")
        );
        assert_eq!(m.0.borrow().len(), 1);
        set_with(&m, "sb-proj-auth-token", Some(&session)).unwrap();
        set_with(&m, "sb-proj-auth-token", None).unwrap();
        assert!(m.0.borrow().is_empty());
        // A value that looks like a header is chunked too, never misread.
        set_with(&m, "x", Some("lumen-keychain-chunks:9")).unwrap();
        assert_eq!(
            get_with(&m, "x").unwrap().as_deref(),
            Some("lumen-keychain-chunks:9")
        );
    }

    #[test]
    fn a_missing_part_is_an_error_not_a_truncated_secret() {
        let m = mem();
        set_with(&m, "k", Some(&"z".repeat(CHUNK_CHARS * 2 + 1))).unwrap();
        m.0.borrow_mut().remove("k#g1.2");
        assert!(get_with(&m, "k").is_err());
    }

    #[test]
    fn a_failed_rewrite_keeps_the_old_value_readable() {
        let m = mem();
        let old = format!("{}{}", "o".repeat(CHUNK_CHARS * 3), "1");
        let new = format!("{}{}", "n".repeat(CHUNK_CHARS * 3), "2");
        set_with(&m, "s", Some(&old)).unwrap();
        // Every point a rewrite can fail at: after 0, 1, 2 or 3 of its 4 parts,
        // or at the header.
        for ok_writes in 0..=4 {
            m.1.set(Some(ok_writes));
            assert!(
                set_with(&m, "s", Some(&new)).is_err(),
                "fails after {ok_writes} writes"
            );
            m.1.set(None);
            assert_eq!(get_with(&m, "s").unwrap().as_deref(), Some(old.as_str()));
        }
        // Shrinking to a short value that fails to store also keeps the old one.
        m.1.set(Some(0));
        assert!(set_with(&m, "s", Some("short")).is_err());
        m.1.set(None);
        assert_eq!(get_with(&m, "s").unwrap().as_deref(), Some(old.as_str()));
        // And a later rewrite that succeeds leaves only the header and its parts.
        set_with(&m, "s", Some(&new)).unwrap();
        assert_eq!(get_with(&m, "s").unwrap().as_deref(), Some(new.as_str()));
        assert_eq!(m.0.borrow().len(), 1 + 4);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn unavailable_elsewhere() {
        assert!(!available());
        assert!(get(SERVICE, "x").is_err());
        assert!(set(SERVICE, "x", Some("v")).is_err());
    }

    /// A service name of its own per run, so tests never touch the app's
    /// secrets and parallel runs never collide.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn test_service(tag: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{SERVICE}.test.{tag}.{}.{nanos}", std::process::id())
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn round_trip_overwrite_and_delete() {
        assert!(available());
        let svc = test_service("rt");
        let name = "lumen.ai.key.anthropic";
        assert_eq!(get(&svc, name).unwrap(), None);
        set(&svc, name, Some("sk-ant-test-1")).unwrap();
        assert_eq!(get(&svc, name).unwrap().as_deref(), Some("sk-ant-test-1"));
        set(&svc, name, Some("sk-ant-test-2")).unwrap();
        assert_eq!(get(&svc, name).unwrap().as_deref(), Some("sk-ant-test-2"));
        set(&svc, name, None).unwrap();
        assert_eq!(get(&svc, name).unwrap(), None);
        // Deleting what is not there is not an error (removeSecret on a fresh install).
        set(&svc, name, None).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn keeps_unicode_and_a_full_session() {
        let svc = test_service("uni");
        let hebrew = "סיסמה-חדר-🔑";
        set(&svc, "lumen.collab.password", Some(hebrew)).unwrap();
        assert_eq!(
            get(&svc, "lumen.collab.password").unwrap().as_deref(),
            Some(hebrew)
        );
        // A Supabase session (JSON with two JWT-sized tokens) fits.
        let session = format!(
            r#"{{"access_token":"{}","refresh_token":"{}"}}"#,
            "a".repeat(900),
            "r".repeat(40)
        );
        set(&svc, "sb-proj-auth-token", Some(&session)).unwrap();
        assert_eq!(
            get(&svc, "sb-proj-auth-token").unwrap().as_deref(),
            Some(session.as_str())
        );
        set(&svc, "lumen.collab.password", None).unwrap();
        set(&svc, "sb-proj-auth-token", None).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn a_session_over_the_windows_blob_limit_round_trips() {
        let svc = test_service("big");
        let session = format!(
            r#"{{"access_token":"{}","provider_token":"{}","user":{{"user_metadata":"{}"}}}}"#,
            "a".repeat(1100),
            "p".repeat(900),
            "מ".repeat(1500)
        );
        set(&svc, "sb-proj-auth-token", Some(&session)).unwrap();
        assert_eq!(
            get(&svc, "sb-proj-auth-token").unwrap().as_deref(),
            Some(session.as_str())
        );
        set(&svc, "sb-proj-auth-token", None).unwrap();
        assert_eq!(get(&svc, "sb-proj-auth-token").unwrap(), None);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn names_are_separate() {
        let svc = test_service("sep");
        set(&svc, "a", Some("1")).unwrap();
        set(&svc, "b", Some("2")).unwrap();
        assert_eq!(get(&svc, "a").unwrap().as_deref(), Some("1"));
        assert_eq!(get(&svc, "b").unwrap().as_deref(), Some("2"));
        set(&svc, "a", None).unwrap();
        assert_eq!(get(&svc, "b").unwrap().as_deref(), Some("2"));
        set(&svc, "b", None).unwrap();
    }
}
