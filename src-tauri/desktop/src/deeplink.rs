//! Deep links (plan W3.9). Lumen registers the `lumen://` scheme:
//!
//! | Link | What it does |
//! |---|---|
//! | `lumen://open?path=notes/idea.md` | open a note of the current vault |
//! | `lumen://open?path=notes/idea.md&vault=Research` | …of the known vault with that folder name |
//! | `lumen://open?path=notes/idea.md&line=12` | …and put the cursor on line 12 |
//! | `lumen://new` | a new note |
//! | `lumen://new?title=Idea&text=…&folder=inbox` | a new note with a title, text, in a folder |
//! | `lumen://capture?text=…` | add a line to the inbox, without opening a note |
//!
//! A link comes from anywhere (a web page, a chat message), so it is parsed
//! strictly: paths are vault-relative, never absolute, never `..`, no control
//! characters; values are length-limited; anything else is refused. A link
//! never names a folder on disk: `vault=` is matched against the vaults the
//! user already opened. Nothing is written without the user seeing it: `new`
//! opens an unsaved note, and `capture` goes to the inbox the user set up.

use crate::percent_decode;

/// Longest link we accept (bytes).
pub const MAX_LINK: usize = 16 * 1024;
/// Longest text in `new` / `capture` (characters).
pub const MAX_TEXT: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum DeepLink {
    Open { path: String, vault: Option<String>, line: Option<u32> },
    New { title: Option<String>, text: Option<String>, folder: Option<String> },
    Capture { text: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum LinkError {
    NotLumen,
    TooLong,
    UnknownAction(String),
    Missing(&'static str),
    BadPath,
    BadValue(&'static str),
    BadEncoding,
}

/// A vault-relative path from a link: forward slashes, no leading slash,
/// no `.` or `..` segment, no drive letter, no backslash, no control
/// characters, no empty segment.
pub fn safe_rel_path(p: &str) -> Result<String, LinkError> {
    let p = p.trim();
    if p.is_empty() || p.len() > 1024 {
        return Err(LinkError::BadPath);
    }
    if p.starts_with('/') || p.contains('\\') || p.chars().any(|c| c.is_control()) {
        return Err(LinkError::BadPath);
    }
    // `C:foo`, `C:/foo`: a drive, not a vault path.
    let b = p.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return Err(LinkError::BadPath);
    }
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(LinkError::BadPath);
        }
    }
    Ok(p.to_string())
}

fn text_value(v: &str, what: &'static str) -> Result<String, LinkError> {
    if v.chars().count() > MAX_TEXT {
        return Err(LinkError::BadValue(what));
    }
    // Keep newlines and tabs; drop other control characters (a link is not a terminal).
    Ok(v.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect())
}

/// Parse a `lumen://` link.
pub fn parse(link: &str) -> Result<DeepLink, LinkError> {
    if link.len() > MAX_LINK {
        return Err(LinkError::TooLong);
    }
    let rest = link
        .strip_prefix("lumen://")
        .or_else(|| link.strip_prefix("lumen:"))
        .ok_or(LinkError::NotLumen)?;
    let (action, query) = match rest.find('?') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    let action = action.trim_end_matches('/').to_ascii_lowercase();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for part in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        let k = percent_decode(k, true).ok_or(LinkError::BadEncoding)?;
        let v = percent_decode(v, true).ok_or(LinkError::BadEncoding)?;
        pairs.push((k, v));
    }
    let get = |k: &str| pairs.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    match action.as_str() {
        "open" => {
            let path = safe_rel_path(&get("path").ok_or(LinkError::Missing("path"))?)?;
            let vault = match get("vault") {
                Some(v) if !v.trim().is_empty() => {
                    let v = v.trim();
                    if v.contains('/') || v.contains('\\') || v.len() > 255 || v.chars().any(|c| c.is_control()) {
                        return Err(LinkError::BadValue("vault"));
                    }
                    Some(v.to_string())
                }
                _ => None,
            };
            let line = match get("line") {
                Some(l) => Some(l.parse::<u32>().ok().filter(|n| *n >= 1).ok_or(LinkError::BadValue("line"))?),
                None => None,
            };
            Ok(DeepLink::Open { path, vault, line })
        }
        "new" => {
            let title = get("title").map(|t| text_value(&t, "title")).transpose()?.map(|t| t.replace(['\n', '\t'], " ").trim().to_string()).filter(|t| !t.is_empty());
            if title.as_ref().is_some_and(|t| t.contains('/') || t.contains('\\') || t.chars().count() > 200) {
                return Err(LinkError::BadValue("title"));
            }
            let text = get("text").map(|t| text_value(&t, "text")).transpose()?.filter(|t| !t.is_empty());
            let folder = get("folder").filter(|f| !f.trim().is_empty()).map(|f| safe_rel_path(&f)).transpose()?;
            Ok(DeepLink::New { title, text, folder })
        }
        "capture" => {
            let text = text_value(&get("text").ok_or(LinkError::Missing("text"))?, "text")?;
            if text.trim().is_empty() {
                return Err(LinkError::Missing("text"));
            }
            Ok(DeepLink::Capture { text })
        }
        other => Err(LinkError::UnknownAction(other.to_string())),
    }
}

/// Build an `open` link (for "Copy link to note"): the inverse of [`parse`].
pub fn open_link(path: &str, vault: Option<&str>) -> String {
    let mut s = format!("lumen://open?path={}", encode(path));
    if let Some(v) = vault {
        s.push_str("&vault=");
        s.push_str(&encode(v));
    }
    s
}

/// Percent-encode everything but unreserved characters and `/`.
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
