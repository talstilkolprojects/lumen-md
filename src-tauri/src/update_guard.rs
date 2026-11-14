//! Anti-downgrade rule for desktop updates (W10.D9, research R3.2).
//!
//! The update manifest (`latest.json`) is not signed, only the binaries are
//! (CVE-2026-95625), so a crafted manifest can offer an *older* build that
//! still carries a valid signature. The updater's own check compares with the
//! running version only. This rule also remembers the highest version ever
//! installed on this machine, so a build rolled back by hand, or one that
//! started from an old installer, is never "updated" to anything below it.
//!
//! No dependencies, so `rustc --test src/update_guard.rs` runs it on its own.

/// (major, minor, patch, prerelease) of "1.2.3", "v1.2.3" or "1.2.3-beta.1"
/// (build metadata after `+` is ignored), or None.
pub fn parse(v: &str) -> Option<(u64, u64, u64, String)> {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let v = v.split('+').next()?;
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) if !p.is_empty() => (c, p.to_string()),
        Some(_) => return None,
        None => (v, String::new()),
    };
    let mut it = core.split('.');
    let n = |s: Option<&str>| -> Option<u64> {
        let s = s?;
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let (a, b, c) = (n(it.next())?, n(it.next())?, n(it.next())?);
    if it.next().is_some() {
        return None;
    }
    Some((a, b, c, pre))
}

/// SemVer precedence of two prerelease strings (an empty one is a release).
fn cmp_pre(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    match (a.is_empty(), b.is_empty()) {
        (true, true) => return Equal,
        (true, false) => return Greater,
        (false, true) => return Less,
        _ => {}
    }
    let (mut x, mut y) = (a.split('.'), b.split('.'));
    loop {
        match (x.next(), y.next()) {
            (None, None) => return Equal,
            (None, Some(_)) => return Less,
            (Some(_), None) => return Greater,
            (Some(p), Some(q)) => {
                let o = match (p.parse::<u64>(), q.parse::<u64>()) {
                    (Ok(m), Ok(n)) => m.cmp(&n),
                    (Ok(_), Err(_)) => Less,
                    (Err(_), Ok(_)) => Greater,
                    _ => p.cmp(q),
                };
                if o != Equal {
                    return o;
                }
            }
        }
    }
}

/// SemVer ordering of two versions, or None when either doesn't parse.
pub fn compare(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let (x, y) = (parse(a)?, parse(b)?);
    Some((x.0, x.1, x.2).cmp(&(y.0, y.1, y.2)).then_with(|| cmp_pre(&x.3, &y.3)))
}

/// The highest of the running version and the one recorded on this machine
/// (a record that doesn't parse is ignored).
pub fn highest(current: &str, recorded: Option<&str>) -> String {
    match recorded {
        Some(r) if compare(r, current) == Some(std::cmp::Ordering::Greater) => r.trim().to_string(),
        _ => current.trim().to_string(),
    }
}

/// Install `remote` only when it is newer than the running version and not
/// below the highest version ever installed here. Anything unparsable is refused.
pub fn accept(current: &str, remote: &str, recorded: Option<&str>) -> bool {
    use std::cmp::Ordering::Greater;
    let floor = highest(current, recorded);
    compare(remote, current) == Some(Greater) && matches!(compare(remote, &floor), Some(o) if o != std::cmp::Ordering::Less)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_newer_version_is_installed() {
        assert!(accept("0.1.0", "0.2.0", None));
        assert!(accept("0.1.0-beta.1", "0.1.0-beta.2", None));
        assert!(accept("0.1.0-beta.2", "0.1.0", None));
        assert!(!accept("0.2.0", "0.2.0", None));
        assert!(!accept("0.2.0", "0.1.9", None)); // an older, validly signed build: refused
        assert!(!accept("0.1.0", "0.1.0-beta.9", None));
    }

    #[test]
    fn never_below_the_highest_ever_installed() {
        // 0.3.0 was installed, then the user put 0.1.0 back by hand: a manifest offering 0.2.0 is refused.
        assert!(!accept("0.1.0", "0.2.0", Some("0.3.0")));
        assert!(accept("0.1.0", "0.3.0", Some("0.3.0")));
        assert!(accept("0.1.0", "0.4.0", Some("0.3.0")));
        // A record below the running version changes nothing.
        assert!(accept("0.5.0", "0.6.0", Some("0.3.0")));
        assert_eq!(highest("0.1.0", Some("0.3.0")), "0.3.0");
        assert_eq!(highest("0.4.0", Some("0.3.0")), "0.4.0");
        assert_eq!(highest("0.4.0", Some("garbage")), "0.4.0");
    }

    #[test]
    fn anything_unparsable_is_refused() {
        assert!(!accept("0.1.0", "", None));
        assert!(!accept("0.1.0", "latest", None));
        assert!(!accept("0.1.0", "1.0", None));
        assert!(!accept("0.1.0", "1.0.0.0", None));
        assert!(!accept("0.1.0", "1.0.0-", None));
        assert!(!accept("garbage", "1.0.0", None));
        assert!(accept("v0.1.0", "v0.2.0+build.7", None));
    }

    #[test]
    fn semver_prerelease_precedence() {
        use std::cmp::Ordering::*;
        assert_eq!(compare("1.0.0-alpha", "1.0.0-alpha.1"), Some(Less));
        assert_eq!(compare("1.0.0-alpha.1", "1.0.0-alpha.beta"), Some(Less));
        assert_eq!(compare("1.0.0-beta.2", "1.0.0-beta.11"), Some(Less));
        assert_eq!(compare("1.0.0-rc.1", "1.0.0"), Some(Less));
        assert_eq!(compare("1.10.0", "1.9.0"), Some(Greater));
    }
}
