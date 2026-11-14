use tauri::menu::{
    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{Emitter, Manager};

mod shell;
mod updates;
mod update_guard;
mod manifest_sig;

mod whisper_core;

/// Build the native menu bar and emit `lumen-menu` events when an item fires.
/// The frontend listens for these events in `useTauriMenu` and dispatches the
/// matching command from the in-app palette so behaviour stays identical to
/// the web build. Predefined items (Cut/Copy/Paste/Undo/Redo) handle
/// themselves natively without round-tripping through the WebView.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let pkg_info = app.package_info();
    let about = PredefinedMenuItem::about(
        app,
        Some("About Lumen"),
        Some(
            AboutMetadataBuilder::new()
                .name(Some("Lumen"))
                .version(Some(pkg_info.version.to_string()))
                .copyright(Some("© 2026 Lumen contributors"))
                .website(Some("https://github.com/talstilkol/lumen-md"))
                .build(),
        ),
    )?;

    let app_menu = SubmenuBuilder::new(app, "Lumen")
        .item(&about)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("file.new", "New").accelerator("CmdOrCtrl+N").build(app)?)
        .item(&MenuItemBuilder::with_id("window.new", "New window").accelerator("CmdOrCtrl+Shift+N").build(app)?)
        .item(&MenuItemBuilder::with_id("file.open", "Open…").accelerator("CmdOrCtrl+O").build(app)?)
        .item(&MenuItemBuilder::with_id("file.insertText", "Insert text…").build(app)?)
        // No accelerator: Ctrl+Alt+N is AltGr+N on Windows (ń); the web view's ⌥⌘N handler skips AltGr.
        .item(&MenuItemBuilder::with_id("file.quickCapture", "Quick capture…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("file.save", "Save").accelerator("CmdOrCtrl+S").build(app)?)
        .item(&MenuItemBuilder::with_id("file.saveAs", "Save As…").accelerator("CmdOrCtrl+Shift+S").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("file.exportHtml", "Export to HTML…").build(app)?)
        .item(&MenuItemBuilder::with_id("file.exportPdf", "Export to PDF").build(app)?)
        .item(&MenuItemBuilder::with_id("file.print", "Print…").accelerator("CmdOrCtrl+P").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("file.toggleWorkspace", "Toggle workspace").build(app)?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("edit.find", "Find & Replace").accelerator("CmdOrCtrl+F").build(app)?)
        .item(&MenuItemBuilder::with_id("edit.workspaceSearch", "Search workspace").accelerator("CmdOrCtrl+Shift+F").build(app)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("view.source", "Source").accelerator("CmdOrCtrl+1").build(app)?)
        .item(&MenuItemBuilder::with_id("view.split", "Split").accelerator("CmdOrCtrl+2").build(app)?)
        .item(&MenuItemBuilder::with_id("view.preview", "Preview").accelerator("CmdOrCtrl+3").build(app)?)
        .item(&MenuItemBuilder::with_id("view.wysiwyg", "WYSIWYG").accelerator("CmdOrCtrl+4").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("view.toggleOutline", "Toggle outline").build(app)?)
        .item(&MenuItemBuilder::with_id("view.focusMode", "Focus mode").accelerator("CmdOrCtrl+Shift+F").build(app)?)
        .item(&MenuItemBuilder::with_id("view.toggleTheme", "Toggle theme").build(app)?)
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("help.commandPalette", "Command palette…").accelerator("CmdOrCtrl+K").build(app)?)
        .item(&MenuItemBuilder::with_id("help.shortcuts", "Keyboard shortcuts").build(app)?)
        .item(&MenuItemBuilder::with_id("help.tour", "Guided tour").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("help.github", "GitHub repository").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&help_menu)
        .build()?;

    Ok(menu)
}

// ── The vault folder (plan 4.3) ─────────────────────────────────────────
//
// The WebView reads and writes notes only through these commands, and only
// inside folders the user picked in the native dialog (lumen-vault checks
// every path). A command names its folder, which must be one the dialog
// granted this session or the saved vault; no command grants a folder from a
// path string. No `fs:` permission is granted to the WebView.

mod lan_discovery;

mod desktop_vault {
    use lumen_vault::{Entry, Stat, Vault};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tauri::{AppHandle, Manager, State};
    use tauri_plugin_dialog::DialogExt;

    /// Folders the user granted (picked in the dialog this session, or the
    /// saved vault), by canonical path, and which one is the vault. A move
    /// reads one granted folder and writes another; only `vault_use` changes
    /// the vault, and only to a granted folder.
    #[derive(Default)]
    pub struct Granted {
        roots: HashMap<String, Vault>,
        active: Option<String>,
    }

    #[derive(Default)]
    pub struct VaultState(pub Mutex<Granted>);

    fn key(v: &Vault) -> String {
        v.root().display().to_string()
    }

    fn config_file(app: &AppHandle) -> Option<PathBuf> {
        app.path().app_config_dir().ok().map(|d| d.join("vault.json"))
    }

    /// The folder chosen earlier, if it still exists: granted and active.
    /// Folders used as the vault before (`known`, plan W3.9) are granted too,
    /// so a file opened from Finder or Explorer opens in its own vault.
    pub fn load(app: &AppHandle) -> Granted {
        let mut g = Granted::default();
        let saved = config_file(app)
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        let root = saved.as_ref().and_then(|v| v.get("root").and_then(|r| r.as_str()).map(str::to_string));
        let known: Vec<String> = saved
            .as_ref()
            .and_then(|v| v.get("known").and_then(|k| k.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()))
            .unwrap_or_default();
        for k in known {
            if let Ok(v) = Vault::open(&k) {
                g.roots.insert(key(&v), v);
            }
        }
        if let Some(Ok(v)) = root.map(Vault::open) {
            let k = key(&v);
            g.active = Some(k.clone());
            g.roots.insert(k, v);
        }
        g
    }

    /// Every granted folder (the known vaults), for placing an opened file.
    pub fn known_roots(state: &State<VaultState>) -> Vec<String> {
        state.0.lock().map(|g| g.roots.keys().cloned().collect()).unwrap_or_default()
    }

    pub fn active_root(state: &State<VaultState>) -> Option<String> {
        state.0.lock().ok()?.active.clone()
    }

    fn save(app: &AppHandle, root: Option<&str>, known: &[String]) -> Result<(), String> {
        let file = config_file(app).ok_or("EIO: no config folder")?;
        match root {
            Some(r) => {
                std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| format!("EIO: {e}"))?;
                let body = serde_json::json!({ "root": r, "known": known }).to_string();
                std::fs::write(&file, body).map_err(|e| format!("EIO: {e}"))
            }
            None => match std::fs::remove_file(&file) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("EIO: {e}")),
            },
        }
    }

    fn lock<'a>(state: &'a State<VaultState>) -> Result<std::sync::MutexGuard<'a, Granted>, String> {
        state.0.lock().map_err(|_| "EIO: vault lock poisoned".to_string())
    }

    fn with<T>(state: &State<VaultState>, root: &str, f: impl FnOnce(&Vault) -> lumen_vault::Result<T>) -> Result<T, String> {
        let g = lock(state)?;
        let vault = g.roots.get(root).ok_or_else(|| "ENOVAULT: this folder was not chosen in the dialog".to_string())?;
        f(vault).map_err(|e| e.to_string())
    }

    /// The vault folder's absolute path, or null when none is chosen.
    #[tauri::command]
    pub fn vault_root(state: State<VaultState>) -> Option<String> {
        lock(&state).ok()?.active.clone()
    }

    /// Ask the user for a folder (native dialog) and grant it. Does not make
    /// it the vault (`vault_use` does, after a move). Null when cancelled.
    #[tauri::command]
    pub async fn vault_pick_folder(app: AppHandle, state: State<'_, VaultState>) -> Result<Option<String>, String> {
        let Some(picked) = app.dialog().file().set_title("Choose the folder for your Lumen vault").blocking_pick_folder() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| format!("EINVAL: {e}"))?;
        let vault = Vault::open(&path).map_err(|e| e.to_string())?;
        let k = key(&vault);
        lock(&state)?.roots.insert(k.clone(), vault);
        Ok(Some(k))
    }

    /// Make a granted folder the vault (remembered for the next launch).
    #[tauri::command]
    pub fn vault_use(app: AppHandle, state: State<VaultState>, root: String) -> Result<(), String> {
        let mut g = lock(&state)?;
        if !g.roots.contains_key(&root) {
            return Err("ENOVAULT: this folder was not chosen in the dialog".into());
        }
        let mut known: Vec<String> = g.roots.keys().cloned().collect();
        known.sort();
        save(&app, Some(&root), &known)?;
        g.active = Some(root);
        Ok(())
    }

    /// Stop using a folder as the vault (it goes back to app storage); forget
    /// every granted folder. The folders on disk are not touched.
    #[tauri::command]
    pub fn vault_forget(app: AppHandle, state: State<VaultState>) -> Result<(), String> {
        save(&app, None, &[])?;
        *lock(&state)? = Granted::default();
        Ok(())
    }

    #[tauri::command]
    pub fn vault_list(state: State<VaultState>, root: String, dir: String) -> Result<Vec<Entry>, String> {
        with(&state, &root, |v| v.list(&dir))
    }

    #[tauri::command]
    pub fn vault_stat(state: State<VaultState>, root: String, path: String) -> Result<Option<Stat>, String> {
        with(&state, &root, |v| v.stat(&path))
    }

    /// The file's bytes, as a raw IPC response (an ArrayBuffer in the WebView).
    #[tauri::command]
    pub fn vault_read(state: State<VaultState>, root: String, path: String) -> Result<tauri::ipc::Response, String> {
        with(&state, &root, |v| v.read(&path)).map(tauri::ipc::Response::new)
    }

    /// Percent-decode a header value (sent `encodeURIComponent`-ed: HTTP
    /// headers carry only ASCII, vault paths are Unicode).
    fn percent_decode(s: &str) -> Result<String, String> {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' {
                let hex = s.get(i + 1..i + 3).ok_or("EINVAL: bad path encoding")?;
                out.push(u8::from_str_radix(hex, 16).map_err(|_| "EINVAL: bad path encoding")?);
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8(out).map_err(|_| "EINVAL: bad path encoding".into())
    }

    fn header(request: &tauri::ipc::Request, name: &str) -> Result<String, String> {
        let raw = request
            .headers()
            .get(name)
            .and_then(|h| h.to_str().ok())
            .ok_or_else(|| format!("EINVAL: missing {name} header"))?;
        percent_decode(raw)
    }

    /// Write a file. The bytes are the raw request body (no JSON array of
    /// numbers for a 5 MB image); folder and path are `x-vault-root` / `x-vault-path`.
    #[tauri::command]
    pub fn vault_write(state: State<VaultState>, request: tauri::ipc::Request) -> Result<(), String> {
        let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
            return Err("EINVAL: vault_write expects raw bytes".into());
        };
        let root = header(&request, "x-vault-root")?;
        let path = header(&request, "x-vault-path")?;
        with(&state, &root, |v| v.write(&path, data))
    }

    /// Every file with size and mtime, for change polling (plan 4.4).
    #[tauri::command]
    pub fn vault_snapshot(state: State<VaultState>, root: String) -> Result<Vec<lumen_vault::SnapEntry>, String> {
        with(&state, &root, |v| v.snapshot())
    }

    #[tauri::command]
    pub fn vault_mkdir(state: State<VaultState>, root: String, path: String) -> Result<(), String> {
        with(&state, &root, |v| v.mkdir(&path))
    }

    #[tauri::command]
    pub fn vault_rename(state: State<VaultState>, root: String, from: String, to: String, overwrite: bool) -> Result<(), String> {
        with(&state, &root, |v| v.rename(&from, &to, overwrite))
    }

    #[tauri::command]
    pub fn vault_remove(state: State<VaultState>, root: String, path: String) -> Result<(), String> {
        with(&state, &root, |v| v.remove(&path))
    }

    /// Keep a backup (e.g. a zip of the app-storage vault before a migration)
    /// in the app's data folder; returns where it went.
    #[tauri::command]
    pub fn vault_backup(app: AppHandle, request: tauri::ipc::Request) -> Result<String, String> {
        let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
            return Err("EINVAL: vault_backup expects raw bytes".into());
        };
        let name = header(&request, "x-backup-name")?;
        let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '_' }).collect();
        if safe.is_empty() || safe.starts_with('.') {
            return Err("EINVAL: invalid backup name".into());
        }
        let dir = app.path().app_data_dir().map_err(|e| format!("EIO: {e}"))?.join("backups");
        std::fs::create_dir_all(&dir).map_err(|e| format!("EIO: {e}"))?;
        let file = dir.join(safe);
        std::fs::write(&file, data).map_err(|e| format!("EIO: {e}"))?;
        Ok(file.display().to_string())
    }
}

/// Is the OS keychain available to `secret_get` / `secret_set` (T36)?
#[tauri::command]
fn secret_available() -> bool {
    lumen_keychain::available()
}

/// Read one secret from the OS keychain; `None` when it isn't there.
#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    lumen_keychain::get(lumen_keychain::SERVICE, &name)
}

/// Store (or with `None`, delete) one secret in the OS keychain.
#[tauri::command]
fn secret_set(name: String, value: Option<String>) -> Result<(), String> {
    lumen_keychain::set(lumen_keychain::SERVICE, &name, value.as_deref())
}

/// A `lumen://` link (plan 4.15.2: `lumen://clip?data=…` from the web
/// clipper), passed to the window. Anything else is ignored.
fn forward_deep_links(app: &tauri::AppHandle, urls: Vec<String>) {
    for url in urls.into_iter().filter(|u| is_lumen_link(u)) {
        let _ = app.emit("lumen-deep-link", url);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
}

/// Only our own scheme, and not absurdly long (a clip carries a page's HTML).
pub fn is_lumen_link(url: &str) -> bool {
    url.len() <= 4 * 1024 * 1024 && url.to_ascii_lowercase().starts_with("lumen://")
}

// ── Desktop Whisper (plan W1.17) ────────────────────────────────────────
//
// ivrit.ai's Hebrew Whisper as ggml through the whisper.cpp CLI
// (`whisper-cli`, MIT), which the user installs; Lumen bundles neither the
// binary nor the model. The model file must be the pinned one (size +
// sha256 from the app); nothing here downloads anything. Logic and tests:
// whisper_core.rs.

#[derive(serde::Serialize)]
struct WhisperStatus {
    cli: Option<String>,
    model: &'static str,
    model_path: Option<String>,
}

#[derive(serde::Serialize)]
struct WhisperSegment {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

fn whisper_dirs(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn whisper_cli(app_data: &std::path::Path) -> Option<std::path::PathBuf> {
    let env = std::env::var("LUMEN_WHISPER_CLI").ok();
    let path = std::env::var("PATH").ok();
    whisper_core::find_cli(&whisper_core::cli_candidates(env.as_deref(), app_data, path.as_deref()))
}

/// Is desktop Whisper usable: a `whisper-cli` binary and the pinned model file?
#[tauri::command]
async fn whisper_status(app: tauri::AppHandle, file: String, bytes: u64, sha256: String) -> Result<WhisperStatus, String> {
    let data = whisper_dirs(&app)?;
    let cli = whisper_cli(&data).map(|p| p.display().to_string());
    let Some(model) = whisper_core::model_path(&data, &file) else { return Err("invalid model file name".into()) };
    let state = tauri::async_runtime::spawn_blocking({
        let model = model.clone();
        move || whisper_core::check_model(&model, bytes, &sha256)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(WhisperStatus { cli, model: state.as_str(), model_path: Some(model.display().to_string()) })
}

/// Transcribe raw 16 kHz mono 16-bit LE PCM (the request body) with
/// whisper-cli. Headers: x-lumen-lang (ISO-639-1), x-lumen-model-file,
/// x-lumen-model-bytes, x-lumen-model-sha256. The audio is written to a
/// temporary WAV that is removed afterwards; it never leaves the machine.
#[tauri::command]
async fn whisper_transcribe(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<Vec<WhisperSegment>, String> {
    let tauri::ipc::InvokeBody::Raw(pcm) = request.body() else { return Err("expected raw PCM".into()) };
    let pcm = pcm.clone();
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let lang = header("x-lumen-lang");
    let file = header("x-lumen-model-file");
    let sha256 = header("x-lumen-model-sha256");
    let bytes: u64 = header("x-lumen-model-bytes").parse().map_err(|_| "x-lumen-model-bytes".to_string())?;
    if !whisper_core::valid_language(&lang) {
        return Err("invalid language".into());
    }
    let data = whisper_dirs(&app)?;
    let cli = whisper_cli(&data).ok_or("whisper-cli not found")?;
    let model = whisper_core::model_path(&data, &file).ok_or("invalid model file name")?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<WhisperSegment>, String> {
        let state = whisper_core::check_model(&model, bytes, &sha256);
        if state != whisper_core::ModelState::Ok {
            return Err(format!("model {}", state.as_str()));
        }
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let tmp = std::env::temp_dir().join(format!("lumen-whisper-{}-{}", std::process::id(), stamp));
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let wav = tmp.join("in.wav");
        let out_prefix = tmp.join("out");
        let run = (|| -> Result<Vec<WhisperSegment>, String> {
            let mut f = std::fs::File::create(&wav).map_err(|e| e.to_string())?;
            whisper_core::write_wav(&mut f, &pcm).map_err(|e| e.to_string())?;
            drop(f);
            let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
            let status = std::process::Command::new(&cli)
                .args(whisper_core::cli_args(&model, &wav, &lang, &out_prefix, threads))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .output()
                .map_err(|e| e.to_string())?;
            if !status.status.success() {
                let err = String::from_utf8_lossy(&status.stderr);
                return Err(format!("whisper-cli failed: {}", err.chars().rev().take(300).collect::<String>().chars().rev().collect::<String>()));
            }
            let srt = std::fs::read_to_string(tmp.join("out.srt")).map_err(|e| e.to_string())?;
            Ok(whisper_core::parse_srt(&srt)
                .into_iter()
                .map(|s| WhisperSegment { start_ms: s.start_ms, end_ms: s.end_ms, text: s.text })
                .collect())
        })();
        let _ = std::fs::remove_dir_all(&tmp);
        run
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Plan W2.17: the presenter view on its own window. With a second screen,
/// the slides (the main window, full screen) go to the other screen and the
/// presenter view opens where the app was; with one screen the presenter
/// view opens beside it. The view is the app itself at `#lumen-presenter`,
/// kept in step with the slides over a BroadcastChannel.
#[cfg(desktop)]
#[tauri::command]
fn open_presenter_window(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window("presenter") {
        let _ = w.set_focus();
        return Ok(false);
    }
    let main = app.get_webview_window("main").ok_or("no main window")?;
    let here = main.current_monitor().map_err(|e| e.to_string())?;
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let other = here.as_ref().and_then(|h| monitors.iter().find(|m| m.position() != h.position()).cloned());
    let mut builder = WebviewWindowBuilder::new(&app, "presenter", WebviewUrl::App("index.html#lumen-presenter".into()))
        .title("Lumen — presenter")
        .inner_size(1100.0, 720.0);
    if let Some(h) = here.as_ref() {
        let s = h.scale_factor();
        builder = builder.position(h.position().x as f64 / s + 60.0, h.position().y as f64 / s + 60.0);
    }
    builder.build().map_err(|e| e.to_string())?;
    if let Some(o) = other {
        main.set_position(*o.position()).map_err(|e| e.to_string())?;
        main.set_fullscreen(true).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

/// The end of a presentation: the presenter window closes and the main window leaves full screen.
#[cfg(desktop)]
#[tauri::command]
fn close_presenter_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("presenter") {
        let _ = w.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        if main.is_fullscreen().unwrap_or(false) {
            main.set_fullscreen(false).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

mod zotero_local;

/// Zotero's answer for the web view (plan W2.15).
#[derive(serde::Serialize)]
struct ZoteroAnswer {
    status: u16,
    total: Option<u64>,
    body: String,
}

/// GET from Zotero's local API on this computer (127.0.0.1:23119, /api/ only).
#[tauri::command]
async fn zotero_local_get(path: String) -> Result<ZoteroAnswer, String> {
    let r = tauri::async_runtime::spawn_blocking(move || zotero_local::get(zotero_local::ZOTERO_PORT, &path))
        .await
        .map_err(|e| e.to_string())??;
    Ok(ZoteroAnswer { status: r.status, total: r.total, body: r.body })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Must be the first plugin: a second launch (the OS opening lumen://…, a
    // double-clicked file) hands its arguments to the running app and exits.
    // Clip links go to the window (plan 4.15); files and open/new/capture
    // links to the desktop shell (plan W3.9).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        forward_deep_links(app, argv.clone());
        shell::handle_args(app, argv.into_iter().skip(1).collect(), std::path::Path::new(&cwd));
    }));
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build()).manage(updates::imp::PendingUpdate::default());
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(desktop_vault::VaultState::default())
        .manage(shell::Shell::default())
        .manage(lan_discovery::DiscoveryState::default())
        .invoke_handler(tauri::generate_handler![
            secret_available,
            secret_get,
            secret_set,
            desktop_vault::vault_root,
            desktop_vault::vault_pick_folder,
            desktop_vault::vault_use,
            desktop_vault::vault_forget,
            desktop_vault::vault_list,
            desktop_vault::vault_stat,
            desktop_vault::vault_read,
            desktop_vault::vault_write,
            desktop_vault::vault_snapshot,
            desktop_vault::vault_mkdir,
            desktop_vault::vault_rename,
            desktop_vault::vault_remove,
            desktop_vault::vault_backup,
            whisper_status,
            whisper_transcribe,
            shell::shell_ready,
            shell::external_read,
            shell::external_write,
            shell::external_close,
            shell::window_new,
            shell::tabs_sync,
            shell::tab_drag_out,
            shell::tab_take,
            shell::tab_pending,
            shell::tab_accept,
            shell::tab_cancel,
            shell::tray_set_menu,
            shell::capture_format,
            // W11.S2: no parameters; the manifest is verified before it is read.
            #[cfg(desktop)]
            updates::imp::lumen_check_update,
            #[cfg(desktop)]
            updates::imp::lumen_install_update,
            #[cfg(desktop)]
            updates::imp::lumen_set_update_channel,
            // The presenter window (plan W2.17) is desktop-only.
            #[cfg(desktop)]
            open_presenter_window,
            #[cfg(desktop)]
            close_presenter_window,
            zotero_local_get,
            lan_discovery::lan_discovery_host,
            lan_discovery::lan_discovery_answer,
            lan_discovery::lan_discovery_stop,
            lan_discovery::lan_discovery_browse,
            lan_discovery::lan_discovery_fetch_offer,
            lan_discovery::lan_discovery_send_answer,
        ])
        .setup(|app| {
            // The folder chosen on an earlier run (plan 4.3).
            let granted = desktop_vault::load(app.handle());
            if let Ok(mut slot) = app.state::<desktop_vault::VaultState>().0.lock() {
                *slot = granted;
            }
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                    // Clip links (plan 4.15) to the window; the shell's own links (plan W3.9).
                    forward_deep_links(&handle, urls.clone());
                    for url in &urls {
                        shell::open_link(&handle, url);
                    }
                });
                // Linux and Windows register the scheme at run time (installers do it too).
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                let _ = app.deep_link().register_all();
                // Plan W3.9: the files this launch was given.
                let cwd = std::env::current_dir().unwrap_or_default();
                shell::handle_args(app.handle(), std::env::args().skip(1).collect(), &cwd);
            }
            #[cfg(desktop)]
            shell::build_tray(app.handle())?;
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                let menu = build_menu(&handle)?;
                app.set_menu(menu)?;
                app.on_menu_event(move |app, event| {
                    let id = event.id().0.as_str();
                    if id == "window.new" {
                        let _ = shell::window_new(app.clone());
                        return;
                    }
                    if id == "help.github" {
                        // Open in default browser via the dialog plugin's url handler.
                        tauri_plugin_dialog::DialogExt::dialog(app)
                            .message("https://github.com/talstilkol/lumen-md")
                            .show(|_| {});
                        return;
                    }
                    let _ = app.emit("lumen-menu", id.to_string());
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                shell::window_closed(window.app_handle(), window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Lumen")
        .run(|app, event| {
            // macOS hands files and links to a running app as an event, not argv.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    if url.scheme() == "file" {
                        if let Ok(path) = url.to_file_path() {
                            shell::open_file(app, &path);
                        }
                    } else {
                        shell::open_link(app, url.as_str());
                    }
                }
            }
            let _ = (app, &event);
        });
}

#[cfg(test)]
mod deep_link_tests {
    use super::is_lumen_link;

    #[test]
    fn only_lumen_links_are_forwarded() {
        assert!(is_lumen_link("lumen://clip?data=%7B%7D"));
        assert!(is_lumen_link("LUMEN://clip"));
        assert!(!is_lumen_link("https://evil.example/lumen://clip"));
        assert!(!is_lumen_link("/usr/bin/lumen"));
        assert!(!is_lumen_link(&format!("lumen://clip?data={}", "x".repeat(4 * 1024 * 1024))));
    }
}
