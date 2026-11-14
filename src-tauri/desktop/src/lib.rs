//! The desktop shell's decisions (plan W3.9), kept out of the Tauri glue so
//! they are tested on any machine:
//!
//! - [`deeplink`]: `lumen://open?path=…`, `lumen://new`, `lumen://capture`;
//! - [`fileopen`]: a file the OS hands us (Finder, Explorer, a file manager,
//!   the command line) → the vault that holds it, or a standalone file;
//! - [`windows`]: window labels, and moving a tab from one window to another
//!   without ever losing or duplicating it;
//! - [`tray`]: the tray menu and the quick-capture entry.

pub mod deeplink;
pub mod fileopen;
pub mod tray;
pub mod windows;

/// Percent-decode a URL component (`+` is a space in query values).
pub fn percent_decode(s: &str, plus_is_space: bool) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                let hex = s.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' if plus_is_space => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests;
