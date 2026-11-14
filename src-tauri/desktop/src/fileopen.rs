//! Opening a file the OS hands us (plan W3.9): a double-click in Finder or
//! Explorer, "Open with Lumen", a file manager on Linux, or `lumen note.md`
//! on the command line.
//!
//! The file opens **in the vault that holds it**: the deepest known vault
//! whose folder contains the file (vaults can be nested, say a project vault
//! inside a home vault; the inner one wins). A file in no known vault opens
//! on its own, as a standalone file the user can save back, without the
//! WebView ever getting a path: it gets a token for that one file.

use std::path::{Component, Path, PathBuf};

/// The file types Lumen registers for (tauri.conf.json `bundle.fileAssociations`).
pub const EXTENSIONS: &[&str] = &["md", "markdown", "base", "excalidraw"];

pub fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTENSIONS.iter().any(|x| x.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Placement {
    /// Inside a known vault: its root, and the path within it (forward slashes).
    InVault { root: String, rel: String },
    /// In no known vault.
    Standalone { path: PathBuf },
}

/// Lexically normalise an absolute path: `.` dropped, `..` applied. (The
/// shell canonicalises with the file system first when the file exists; this
/// keeps the comparison right for symlink-free paths and in tests.)
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Case-insensitive file systems (macOS default, Windows) compare paths
/// ignoring case; Linux does not.
fn same(a: &str, b: &str, case_insensitive: bool) -> bool {
    if case_insensitive {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

/// The path of `file` inside `root`, if it is inside it.
pub fn relative_to(file: &Path, root: &Path, case_insensitive: bool) -> Option<String> {
    let f: Vec<String> = normalize(file).components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let r: Vec<String> = normalize(root).components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if f.len() <= r.len() {
        return None;
    }
    for (a, b) in r.iter().zip(f.iter()) {
        if !same(a, b, case_insensitive) {
            return None;
        }
    }
    Some(f[r.len()..].join("/"))
}

/// Where a file opens, given the known vault roots.
pub fn place(file: &Path, vault_roots: &[String], case_insensitive: bool) -> Placement {
    let mut best: Option<(usize, &String, String)> = None;
    for root in vault_roots {
        if let Some(rel) = relative_to(file, Path::new(root), case_insensitive) {
            let depth = normalize(Path::new(root)).components().count();
            if best.as_ref().map_or(true, |(d, _, _)| depth > *d) {
                best = Some((depth, root, rel));
            }
        }
    }
    match best {
        Some((_, root, rel)) => Placement::InVault { root: root.clone(), rel },
        None => Placement::Standalone { path: normalize(file) },
    }
}

/// What the app was launched with (argv after the program), or what a second
/// instance forwarded: supported files and `lumen://` links. Flags, unknown
/// file types and the macOS `-psn_` process argument are ignored.
#[derive(Debug, Default, PartialEq)]
pub struct Launch {
    pub files: Vec<PathBuf>,
    pub links: Vec<String>,
}

pub fn parse_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Launch {
    let mut out = Launch::default();
    for a in args {
        if a.starts_with("lumen:") {
            out.links.push(a);
        } else if a.starts_with('-') {
            continue;
        } else if let Some(rest) = a.strip_prefix("file://") {
            let p = PathBuf::from(crate::percent_decode(rest, false).unwrap_or_default());
            if is_supported(&p) {
                out.files.push(normalize(&p));
            }
        } else {
            let p = Path::new(&a);
            let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
            if is_supported(&abs) {
                out.files.push(normalize(&abs));
            }
        }
    }
    out
}

/// Files opened from outside any vault, by token. The WebView reads and
/// saves a standalone file by its token; it never sees or sends a path, and
/// a token only exists for a file the OS handed us.
#[derive(Default)]
pub struct Standalone {
    next: u64,
    files: Vec<(String, PathBuf)>,
}

impl Standalone {
    /// A token for this file (the same token if it is already open).
    pub fn grant(&mut self, path: PathBuf) -> String {
        if let Some((t, _)) = self.files.iter().find(|(_, p)| *p == path) {
            return t.clone();
        }
        self.next += 1;
        let token = format!("f{}", self.next);
        self.files.push((token.clone(), path));
        token
    }

    pub fn path(&self, token: &str) -> Option<&Path> {
        self.files.iter().find(|(t, _)| t == token).map(|(_, p)| p.as_path())
    }

    pub fn release(&mut self, token: &str) {
        self.files.retain(|(t, _)| t != token);
    }

    /// The display name the WebView may show (the file name, not the path).
    pub fn name(&self, token: &str) -> Option<String> {
        self.path(token).and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned())
    }
}
