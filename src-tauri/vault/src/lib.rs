//! The desktop vault (plan 4.3): the user's notes in one folder on disk.
//!
//! Every path the WebView sends is relative to the vault root and checked
//! before it touches the disk: `.` / `..` / absolute / drive / backslash
//! segments are refused, and the deepest existing ancestor of the path is
//! canonicalised and must lie inside the canonical root, so neither a crafted
//! path nor a symlink inside the folder can reach anything outside it. This
//! is the only file-system access the WebView has (no broad `fs:` scope).
//!
//! Semantics follow the TypeScript `VaultBackend` contract
//! (src/storage/vault/types.ts): error codes ENOENT / EEXIST / EKIND / EINVAL,
//! `write` creates parents and replaces the file atomically (temporary
//! sibling + rename), `rename` refuses to replace without `overwrite`, to
//! move a folder into itself, or to replace a folder that holds the source.

use serde::Serialize;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultError {
    pub code: &'static str,
    pub message: String,
}

impl VaultError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn io(path: &str, e: io::Error) -> Self {
        match e.kind() {
            io::ErrorKind::NotFound => Self::new("ENOENT", format!("\"{path}\" not found")),
            io::ErrorKind::AlreadyExists => {
                Self::new("EEXIST", format!("\"{path}\" already exists"))
            }
            _ => Self::new("EIO", format!("\"{path}\": {e}")),
        }
    }
}

impl fmt::Display for VaultError {
    /// `CODE: message` — the TypeScript adapter maps the code to its error classes.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for VaultError {}

pub type Result<T> = std::result::Result<T, VaultError>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Stat {
    pub kind: &'static str,
    pub size: u64,
    pub mtime: u64,
}

pub struct Vault {
    root: PathBuf,
}

static TMP: AtomicU64 = AtomicU64::new(0);

fn mtime_ms(m: &fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The checked segments of a vault path.
pub fn segments(path: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        // `\` and `:` are separators / drive markers only on Windows; on Unix
        // they are ordinary filename characters and must stay addressable.
        let windows_only = cfg!(windows) && (seg.contains('\\') || seg.contains(':'));
        let bad = seg == "." || seg == ".." || seg.contains('\0') || windows_only;
        if bad {
            return Err(VaultError::new(
                "EINVAL",
                format!("Invalid vault path \"{path}\""),
            ));
        }
        out.push(seg.to_string());
    }
    Ok(out)
}

impl Vault {
    /// Open the vault at `root` (an existing folder).
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = fs::canonicalize(root.as_ref())
            .map_err(|e| VaultError::io(&root.as_ref().display().to_string(), e))?;
        if !root.is_dir() {
            return Err(VaultError::new(
                "EKIND",
                format!("\"{}\" is not a folder", root.display()),
            ));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The absolute path for `rel`, checked to stay inside the root.
    fn resolve(&self, rel: &str) -> Result<(PathBuf, Vec<String>)> {
        let segs = segments(rel)?;
        let mut p = self.root.clone();
        for s in &segs {
            p.push(s);
        }
        // The deepest existing ancestor (the path itself when it exists) must
        // canonicalise inside the root: a symlink pointing out is refused.
        let mut probe = p.clone();
        loop {
            match fs::symlink_metadata(&probe) {
                Ok(_) => {
                    let real = fs::canonicalize(&probe).map_err(|e| VaultError::io(rel, e))?;
                    if !real.starts_with(&self.root) {
                        return Err(VaultError::new(
                            "EINVAL",
                            format!("\"{rel}\" leads outside the vault"),
                        ));
                    }
                    break;
                }
                Err(_) => {
                    if !probe.pop() || probe == self.root {
                        break;
                    }
                }
            }
        }
        Ok((p, segs))
    }

    fn join(segs: &[String]) -> String {
        segs.join("/")
    }

    /// Direct children of folder `dir`, folders first, then files, by name.
    pub fn list(&self, dir: &str) -> Result<Vec<Entry>> {
        let (p, segs) = self.resolve(dir)?;
        let meta = fs::metadata(&p).map_err(|e| VaultError::io(dir, e))?;
        if !meta.is_dir() {
            return Err(VaultError::new("ENOENT", format!("\"{dir}\" not found")));
        }
        let mut out = Vec::new();
        for item in fs::read_dir(&p).map_err(|e| VaultError::io(dir, e))? {
            let item = item.map_err(|e| VaultError::io(dir, e))?;
            let name = match item.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue, // not valid Unicode: not addressable as a vault path
            };
            let mut child = segs.clone();
            child.push(name.clone());
            let path = Self::join(&child);
            // A symlink to a folder is not listed: one pointing at the root or
            // an ancestor would make every recursive walk endless. (Links to
            // files are listed; `resolve` keeps reads of them inside the root.)
            let is_link = item.file_type().map(|t| t.is_symlink()).unwrap_or(false);
            match fs::metadata(item.path()) {
                Ok(m) if m.is_dir() && is_link => continue,
                Ok(m) if m.is_dir() => out.push(Entry {
                    name,
                    path,
                    kind: "directory",
                    size: None,
                    mtime: None,
                }),
                Ok(m) => out.push(Entry {
                    name,
                    path,
                    kind: "file",
                    size: Some(m.len()),
                    mtime: Some(mtime_ms(&m)),
                }),
                Err(_) => out.push(Entry {
                    name,
                    path,
                    kind: "file",
                    size: None,
                    mtime: None,
                }),
            }
        }
        out.sort_by(|a, b| {
            (a.kind != "directory")
                .cmp(&(b.kind != "directory"))
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(out)
    }

    pub fn stat(&self, path: &str) -> Result<Option<Stat>> {
        let (p, _) = self.resolve(path)?;
        match fs::metadata(&p) {
            Ok(m) if m.is_dir() => Ok(Some(Stat {
                kind: "directory",
                size: 0,
                mtime: 0,
            })),
            Ok(m) => Ok(Some(Stat {
                kind: "file",
                size: m.len(),
                mtime: mtime_ms(&m),
            })),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(VaultError::io(path, e)),
        }
    }

    pub fn read(&self, path: &str) -> Result<Vec<u8>> {
        let (p, segs) = self.resolve(path)?;
        if segs.is_empty() || !p.is_file() {
            return Err(VaultError::new("ENOENT", format!("\"{path}\" not found")));
        }
        fs::read(&p).map_err(|e| VaultError::io(path, e))
    }

    /// Ensure every folder above `segs` exists; a file in the way is EKIND.
    fn make_parents(&self, segs: &[String], path: &str) -> Result<()> {
        let mut p = self.root.clone();
        for s in &segs[..segs.len().saturating_sub(1)] {
            p.push(s);
            match fs::metadata(&p) {
                Ok(m) if m.is_dir() => {}
                Ok(_) => {
                    return Err(VaultError::new(
                        "EKIND",
                        format!("Cannot write \"{path}\": a file is in the way"),
                    ))
                }
                Err(_) => fs::create_dir(&p).map_err(|e| VaultError::io(path, e))?,
            }
        }
        Ok(())
    }

    /// Create or replace a file, atomically (temporary sibling, then rename).
    pub fn write(&self, path: &str, data: &[u8]) -> Result<()> {
        let (p, segs) = self.resolve(path)?;
        if segs.is_empty() || p.is_dir() {
            return Err(VaultError::new(
                "EKIND",
                format!("Cannot write \"{path}\": a folder of that name is in the way"),
            ));
        }
        self.make_parents(&segs, path)?;
        // The temporary file is created exclusively (O_CREAT|O_EXCL): it never
        // follows a symlink planted at that name, and a taken name is retried.
        let mut attempt = 0;
        let (tmp, mut file) = loop {
            let n = TMP.fetch_add(1, Ordering::Relaxed);
            let tmp = p.with_file_name(format!(".lumen-tmp-{}-{n}", std::process::id()));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
            {
                Ok(f) => break (tmp, f),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists && attempt < 64 => attempt += 1,
                Err(e) => return Err(VaultError::io(path, e)),
            }
        };
        let result = (|| {
            file.write_all(data)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&tmp, &p)
        })();
        if let Err(e) = result {
            let _ = fs::remove_file(&tmp);
            return Err(VaultError::io(path, e));
        }
        Ok(())
    }

    pub fn mkdir(&self, path: &str) -> Result<()> {
        let (_, segs) = self.resolve(path)?;
        if segs.is_empty() {
            return Ok(());
        }
        let mut cur = self.root.clone();
        for s in &segs {
            cur.push(s);
            match fs::metadata(&cur) {
                Ok(m) if m.is_dir() => {}
                Ok(_) => {
                    return Err(VaultError::new(
                        "EKIND",
                        format!("Cannot create folder \"{path}\": a file is in the way"),
                    ))
                }
                Err(_) => fs::create_dir(&cur).map_err(|e| VaultError::io(path, e))?,
            }
        }
        Ok(())
    }

    pub fn rename(&self, from: &str, to: &str, overwrite: bool) -> Result<()> {
        let (src, a) = self.resolve(from)?;
        let (dst, b) = self.resolve(to)?;
        if a.is_empty() || b.is_empty() {
            return Err(VaultError::new("EINVAL", "Cannot move the vault root"));
        }
        if a == b {
            return Ok(());
        }
        if b.len() > a.len() && b[..a.len()] == a[..] {
            return Err(VaultError::new(
                "EINVAL",
                format!("Cannot move \"{from}\" into itself"),
            ));
        }
        if a.len() > b.len() && a[..b.len()] == b[..] {
            return Err(VaultError::new(
                "EINVAL",
                format!("Cannot replace \"{to}\" with \"{from}\", which is inside it"),
            ));
        }
        let src_meta = fs::symlink_metadata(&src).map_err(|e| VaultError::io(from, e))?;
        // On a case-insensitive disk "Note.md" and "note.md" are one entry:
        // that is a rename, not a conflict.
        let same_entry = match (fs::canonicalize(&src), fs::canonicalize(&dst)) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        };
        if !same_entry {
            if let Ok(dst_meta) = fs::symlink_metadata(&dst) {
                if !overwrite {
                    return Err(VaultError::new(
                        "EEXIST",
                        format!("\"{to}\" already exists"),
                    ));
                }
                // Moving a folder into the destination's aliased ancestry is caught above
                // textually; also check the real paths.
                if let (Ok(rs), Ok(rd)) = (fs::canonicalize(&src), fs::canonicalize(&dst)) {
                    if rd.starts_with(&rs) || rs.starts_with(&rd) {
                        return Err(VaultError::new(
                            "EINVAL",
                            format!("Cannot move \"{from}\" onto \"{to}\""),
                        ));
                    }
                }
                if dst_meta.is_dir() || src_meta.is_dir() {
                    if dst_meta.is_dir() {
                        fs::remove_dir_all(&dst)
                    } else {
                        fs::remove_file(&dst)
                    }
                    .map_err(|e| VaultError::io(to, e))?;
                }
            }
        }
        if src_meta.is_dir() {
            if let Ok(rs) = fs::canonicalize(&src) {
                // A destination whose existing parent is the source (aliased): into itself.
                if let Some(parent) = dst.parent() {
                    if let Ok(rp) = fs::canonicalize(parent) {
                        if rp.starts_with(&rs) {
                            return Err(VaultError::new(
                                "EINVAL",
                                format!("Cannot move \"{from}\" into itself"),
                            ));
                        }
                    }
                }
            }
        }
        self.make_parents(&b, to)?;
        fs::rename(&src, &dst).map_err(|e| VaultError::io(from, e))
    }

    pub fn remove(&self, path: &str) -> Result<()> {
        let (p, segs) = self.resolve(path)?;
        if segs.is_empty() {
            return Err(VaultError::new(
                "EINVAL",
                "Cannot delete the workspace root",
            ));
        }
        let m = fs::symlink_metadata(&p).map_err(|e| VaultError::io(path, e))?;
        if m.is_dir() {
            fs::remove_dir_all(&p)
        } else {
            fs::remove_file(&p)
        }
        .map_err(|e| VaultError::io(path, e))
    }

    /// Every file of the vault with its size and mtime (ms), in one call: the
    /// desktop app polls this to notice changes made by other programs
    /// (plan 4.4). Folder symlinks are not followed (as in `list`), and the
    /// temporary files of in-flight atomic writes are left out.
    pub fn snapshot(&self) -> Result<Vec<SnapEntry>> {
        let mut out = Vec::new();
        self.snapshot_into(&self.root.clone(), "", &mut out)?;
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    fn snapshot_into(&self, dir: &Path, prefix: &str, out: &mut Vec<SnapEntry>) -> Result<()> {
        let items = match fs::read_dir(dir) {
            Ok(it) => it,
            // A folder deleted while we walk it: nothing in it any more.
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(VaultError::io(prefix, e)),
        };
        for item in items.flatten() {
            let Ok(name) = item.file_name().into_string() else {
                continue;
            };
            if name.starts_with(".lumen-tmp-") {
                continue;
            }
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let is_link = item.file_type().map(|t| t.is_symlink()).unwrap_or(false);
            match fs::metadata(item.path()) {
                Ok(m) if m.is_dir() && is_link => {}
                Ok(m) if m.is_dir() => self.snapshot_into(&item.path(), &path, out)?,
                Ok(m) => out.push(SnapEntry {
                    path,
                    size: m.len(),
                    mtime: mtime_ms(&m),
                }),
                Err(_) => {}
            }
        }
        Ok(())
    }
}

/// One file in a `snapshot`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SnapEntry {
    pub path: String,
    pub size: u64,
    pub mtime: u64,
}

#[cfg(test)]
mod tests;
