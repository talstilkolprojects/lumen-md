//! Stub tauri-plugin-single-instance 2.5 (plan W4.23); signature from plugins-workspace/plugins/single-instance/src/lib.rs.
use tauri::{plugin::TauriPlugin, AppHandle, Runtime};
pub fn init<R: Runtime, F: FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static>(f: F) -> TauriPlugin<R> { unimplemented!() }
pub fn destroy<R: Runtime, M: tauri::Manager<R>>(manager: &M) {}
