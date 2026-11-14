//! The desktop shell (plan W3.9): several windows, tabs that move between
//! them, the tray with quick capture, file associations and `lumen://` links.
//!
//! Every decision lives in the std-only `lumen-desktop` crate
//! (src-tauri/desktop, tested with `cargo test --offline` or `rustc --test`);
//! this file is the Tauri glue around it: events in, events out.
//!
//! Safety, as in the rest of the shell:
//! - a link or a file never gives the WebView a path to read: a file in a
//!   known vault opens through the vault commands (which check every path),
//!   and a file outside every vault is reached by a token for that one file;
//! - a link never names a folder on disk (`vault=` matches a vault's name);
//! - `capture` only appends to the inbox, written by the WebView's own vault layer.

use crate::desktop_vault::VaultState;
use lumen_desktop::{deeplink, fileopen, tray, windows};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// What the main window is asked to open (event `lumen-open`).
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum OpenRequest {
    /// A note of a known vault: switch to that vault if needed, open `rel`.
    Vault { root: String, rel: String, line: Option<u32> },
    /// A file in no known vault, by token (`external_read` / `external_write`).
    File { token: String, name: String },
    /// A vault named in a link that isn't one the user opened.
    UnknownVault { name: String },
    New { title: Option<String>, text: Option<String>, folder: Option<String> },
    Capture { text: String },
}

#[derive(Default)]
pub struct ShellState {
    /// Opens that arrived before the main window was ready (cold start).
    pending: Vec<OpenRequest>,
    main_ready: bool,
    standalone: fileopen::Standalone,
    tabs: windows::Tabs,
    tray_labels: tray::Labels,
    /// Recent notes of the active vault for the tray: (display name, vault path).
    recent: Vec<(String, String)>,
}

pub struct Shell(pub Mutex<ShellState>);

impl Default for Shell {
    fn default() -> Self {
        Shell(Mutex::new(ShellState::default()))
    }
}

fn lock<'a>(s: &'a State<Shell>) -> Result<std::sync::MutexGuard<'a, ShellState>, String> {
    s.0.lock().map_err(|_| "EIO: shell lock poisoned".to_string())
}

const CASE_INSENSITIVE: bool = cfg!(any(target_os = "macos", target_os = "windows"));

/// Send an open request to the main window, or keep it until the window asks.
fn deliver(app: &AppHandle, req: OpenRequest) {
    let shell = app.state::<Shell>();
    let ready = shell.0.lock().map(|s| s.main_ready).unwrap_or(false);
    if ready {
        let _ = app.emit_to(windows::MAIN, "lumen-open", req);
        if let Some(w) = app.get_webview_window(windows::MAIN) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    } else if let Ok(mut s) = shell.0.lock() {
        s.pending.push(req);
    }
}

/// A file the OS handed us (double-click, "Open with", argv).
pub fn open_file(app: &AppHandle, path: &Path) {
    if !fileopen::is_supported(path) {
        return;
    }
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| fileopen::normalize(path));
    let roots = crate::desktop_vault::known_roots(&app.state::<VaultState>());
    let req = match fileopen::place(&path, &roots, CASE_INSENSITIVE) {
        fileopen::Placement::InVault { root, rel } => OpenRequest::Vault { root, rel, line: None },
        fileopen::Placement::Standalone { path } => {
            let shell = app.state::<Shell>();
            let Ok(mut s) = shell.0.lock() else { return };
            let token = s.standalone.grant(path);
            let name = s.standalone.name(&token).unwrap_or_default();
            OpenRequest::File { token, name }
        }
    };
    deliver(app, req);
}

/// A `lumen://` link (deep-link plugin, a second instance's argv, or macOS).
pub fn open_link(app: &AppHandle, link: &str) {
    let parsed = match deeplink::parse(link) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("lumen: ignored link ({e:?})");
            return;
        }
    };
    let req = match parsed {
        deeplink::DeepLink::Open { path, vault, line } => {
            let vs = app.state::<VaultState>();
            let root = match vault {
                None => crate::desktop_vault::active_root(&vs),
                Some(name) => {
                    let found = crate::desktop_vault::known_roots(&vs).into_iter().find(|r| Path::new(r).file_name().map(|n| n.to_string_lossy() == name.as_str()).unwrap_or(false));
                    if found.is_none() {
                        deliver(app, OpenRequest::UnknownVault { name });
                        return;
                    }
                    found
                }
            };
            match root {
                Some(root) => OpenRequest::Vault { root, rel: path, line },
                // No folder vault: the main window opens `path` from app storage.
                None => OpenRequest::Vault { root: String::new(), rel: path, line },
            }
        }
        deeplink::DeepLink::New { title, text, folder } => OpenRequest::New { title, text, folder },
        deeplink::DeepLink::Capture { text } => OpenRequest::Capture { text },
    };
    deliver(app, req);
}

/// argv of this or a second instance: files and links.
pub fn handle_args(app: &AppHandle, args: Vec<String>, cwd: &Path) {
    let launch = fileopen::parse_args(args, cwd);
    for f in launch.files {
        open_file(app, &f);
    }
    for l in launch.links {
        open_link(app, &l);
    }
}

// ── Commands for the WebView ───────────────────────────────────────────

/// The main window is ready: the opens that waited for it.
#[tauri::command]
pub fn shell_ready(window: tauri::Window, state: State<Shell>) -> Result<Vec<OpenRequest>, String> {
    if window.label() != windows::MAIN {
        return Ok(vec![]);
    }
    let mut s = lock(&state)?;
    s.main_ready = true;
    Ok(std::mem::take(&mut s.pending))
}

/// The text of a file opened from outside every vault.
#[tauri::command]
pub fn external_read(state: State<Shell>, token: String) -> Result<tauri::ipc::Response, String> {
    let path: PathBuf = lock(&state)?.standalone.path(&token).ok_or("ENOENT: unknown file token")?.to_path_buf();
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("EIO: {e}"))
}

/// Save a file opened from outside every vault (raw bytes; token in `x-file-token`).
#[tauri::command]
pub fn external_write(state: State<Shell>, request: tauri::ipc::Request) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("EINVAL: external_write expects raw bytes".into());
    };
    let token = request.headers().get("x-file-token").and_then(|h| h.to_str().ok()).ok_or("EINVAL: missing x-file-token")?.to_string();
    let path: PathBuf = lock(&state)?.standalone.path(&token).ok_or("ENOENT: unknown file token")?.to_path_buf();
    // Write next to the file, then rename over it: a crash never leaves half a note.
    let tmp = path.with_extension("lumen-tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("EIO: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("EIO: {e}"))
}

#[tauri::command]
pub fn external_close(state: State<Shell>, token: String) -> Result<(), String> {
    lock(&state)?.standalone.release(&token);
    Ok(())
}

fn editor_labels(app: &AppHandle) -> Vec<String> {
    app.webview_windows().keys().cloned().collect()
}

fn create_editor_window(app: &AppHandle, at: Option<(i32, i32)>) -> Result<String, String> {
    let label = windows::next_label(&editor_labels(app));
    let url = WebviewUrl::App(format!("index.html?window={label}").into());
    let mut b = WebviewWindowBuilder::new(app, &label, url).title("Lumen").inner_size(1100.0, 760.0).min_inner_size(720.0, 480.0);
    if let Some((x, y)) = at {
        b = b.position(x as f64, y as f64);
    }
    b.build().map_err(|e| e.to_string())?;
    Ok(label)
}

/// A new, empty editor window (⌘⇧N, *New window*).
#[tauri::command]
pub fn window_new(app: AppHandle) -> Result<String, String> {
    create_editor_window(&app, None)
}

/// The tabs a window shows, so moves know who owns what.
#[tauri::command]
pub fn tabs_sync(window: tauri::Window, state: State<Shell>, tabs: Vec<String>) -> Result<(), String> {
    let mut s = lock(&state)?;
    let label = window.label().to_string();
    for t in s.tabs.tabs_of(&label) {
        if !tabs.contains(&t) {
            s.tabs.close(&t);
        }
    }
    for t in tabs {
        if s.tabs.owner(&t).is_none() {
            s.tabs.open(&t, &label);
        }
    }
    Ok(())
}

/// A tab was dragged out of its window and dropped. `state` is its editing
/// state (JSON). The tab goes to the window under the pointer, or a new one;
/// the source keeps it until the target has it open (`tab_accept`).
#[tauri::command]
pub fn tab_drag_out(app: AppHandle, window: tauri::Window, state: State<Shell>, tab: String, tab_state: String) -> Result<Option<String>, String> {
    let from = window.label().to_string();
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    // Front-most first: the focused window, then the others.
    let mut geoms: Vec<windows::WinGeom> = Vec::new();
    for (label, w) in app.webview_windows() {
        let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { continue };
        let g = windows::WinGeom { label: label.clone(), x: pos.x, y: pos.y, w: size.width, h: size.height, minimized: w.is_minimized().unwrap_or(false) };
        if w.is_focused().unwrap_or(false) {
            geoms.insert(0, g);
        } else {
            geoms.push(g);
        }
    }
    let Some(target) = windows::drop_target(cursor.x as i32, cursor.y as i32, &from, &geoms) else { return Ok(None) };
    let to = match target {
        windows::DropTarget::Window(l) => l,
        windows::DropTarget::NewWindow { x, y } => create_editor_window(&app, Some((x, y)))?,
    };
    {
        let mut s = lock(&state)?;
        if s.tabs.owner(&tab).is_none() {
            s.tabs.open(&tab, &from);
        }
        s.tabs.offer(&tab, &from, &to, tab_state).map_err(|e| format!("{e:?}"))?;
    }
    // An existing window opens it now; a new one asks with `tab_pending` once loaded.
    let _ = app.emit_to(to.as_str(), "lumen-tab-offer", tab.clone());
    Ok(Some(to))
}

/// The tab offered to this window, with its editing state.
#[tauri::command]
pub fn tab_take(window: tauri::Window, state: State<Shell>, tab: String) -> Result<Option<String>, String> {
    Ok(lock(&state)?.tabs.offered_state(&tab, window.label()).map(str::to_string))
}

/// Offers waiting for this window (a window created by a drop asks on load).
#[tauri::command]
pub fn tab_pending(window: tauri::Window, state: State<Shell>) -> Result<Vec<(String, String)>, String> {
    let s = lock(&state)?;
    let label = window.label();
    let mut out = Vec::new();
    for t in s.tabs.tabs_of_offers_to(label) {
        if let Some(st) = s.tabs.offered_state(&t, label) {
            out.push((t.clone(), st.to_string()));
        }
    }
    Ok(out)
}

/// This window has the tab open: the source closes its copy.
#[tauri::command]
pub fn tab_accept(app: AppHandle, window: tauri::Window, state: State<Shell>, tab: String) -> Result<(), String> {
    let source = lock(&state)?.tabs.accept(&tab, window.label()).map_err(|e| format!("{e:?}"))?;
    let _ = app.emit_to(source.as_str(), "lumen-tab-moved", tab);
    Ok(())
}

/// The target never took the tab: it stays where it was.
#[tauri::command]
pub fn tab_cancel(state: State<Shell>, tab: String) -> Result<(), String> {
    let _ = lock(&state)?.tabs.cancel(&tab);
    Ok(())
}

/// The tray's labels (UI language) and recent notes (name, vault path).
#[tauri::command]
pub fn tray_set_menu(app: AppHandle, state: State<Shell>, labels: Option<TrayLabels>, recent: Vec<(String, String)>) -> Result<(), String> {
    {
        let mut s = lock(&state)?;
        if let Some(l) = labels {
            s.tray_labels = tray::Labels { capture: l.capture, new_note: l.new_note, recent: l.recent, show: l.show, quit: l.quit };
        }
        s.recent = recent.into_iter().filter(|(_, p)| deeplink::safe_rel_path(p).is_ok()).take(tray::MAX_RECENT).collect();
    }
    rebuild_tray_menu(&app).map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
pub struct TrayLabels {
    capture: String,
    new_note: String,
    recent: String,
    show: String,
    quit: String,
}

/// Quick capture: the inbox's new text with one entry added, or null for
/// empty text. The WebView writes it through its vault layer (a folder vault
/// or app storage alike), so there is one write path and one change event.
/// `offset_minutes` is the local offset from UTC (the WebView knows it).
#[tauri::command]
pub fn capture_format(text: String, existing: String, offset_minutes: i32) -> Option<String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let entry = tray::capture_entry(&text, now, offset_minutes.clamp(-14 * 60, 14 * 60))?;
    Some(tray::append_to_inbox(&existing, &entry))
}

/// Show (or create) the small quick-capture window.
pub fn show_capture(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(windows::CAPTURE) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, windows::CAPTURE, WebviewUrl::App("index.html?window=capture".into()))
        .title("Lumen")
        .inner_size(460.0, 220.0)
        .resizable(false)
        .always_on_top(true)
        .center()
        .build();
}

fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    let snapshot = app.state::<Shell>().0.lock().ok().map(|s| (s.tray_labels.clone(), s.recent.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>()));
    let Some((labels, recent)) = snapshot else { return Ok(()) };
    let mut b = MenuBuilder::new(app);
    for item in tray::menu(&labels, &recent) {
        b = match item {
            tray::Item::Action { id, label } => b.item(&MenuItemBuilder::with_id(id, label).build(app)?),
            tray::Item::Header(label) => b.item(&MenuItemBuilder::new(label).enabled(false).build(app)?),
            tray::Item::Separator => b.separator(),
        };
    }
    let menu = b.build()?;
    if let Some(t) = app.tray_by_id("lumen") {
        t.set_menu(Some(menu))?;
    }
    Ok(())
}

/// The tray icon, built once at startup.
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let Some(icon) = app.default_window_icon().cloned() else { return Ok(()) };
    TrayIconBuilder::with_id("lumen")
        .icon(icon)
        .tooltip("Lumen")
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            match id {
                tray::CAPTURE => show_capture(app),
                tray::NEW_NOTE => deliver(app, OpenRequest::New { title: None, text: None, folder: None }),
                tray::SHOW => {
                    if let Some(w) = app.get_webview_window(windows::MAIN) {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                tray::QUIT => app.exit(0),
                other => {
                    if let Some(i) = tray::recent_index(other) {
                        let rel = app.state::<Shell>().0.lock().ok().and_then(|s| s.recent.get(i).map(|(_, p)| p.clone()));
                        if let Some(rel) = rel {
                            let root = crate::desktop_vault::active_root(&app.state::<VaultState>()).unwrap_or_default();
                            deliver(app, OpenRequest::Vault { root, rel, line: None });
                        }
                    }
                }
            }
        })
        .build(app)?;
    rebuild_tray_menu(app)
}

/// A window closed: moves to it are cancelled, its tabs forgotten.
pub fn window_closed(app: &AppHandle, label: &str) {
    if let Ok(mut s) = app.state::<Shell>().0.lock() {
        for tab in s.tabs.window_closed(label) {
            let _ = app.emit("lumen-tab-cancelled", tab);
        }
    }
}
