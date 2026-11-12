//! Stub tauri-plugin-dialog 2.8 (plan W4.23); signatures from plugins-workspace/plugins/dialog/src/lib.rs.
use tauri::{plugin::TauriPlugin, Manager, Runtime};
pub use tauri_plugin_fs::FilePath;
pub struct Dialog<R: Runtime>(std::marker::PhantomData<R>);
pub trait DialogExt<R: Runtime> { fn dialog(&self) -> &Dialog<R>; }
impl<R: Runtime, T: Manager<R>> DialogExt<R> for T { fn dialog(&self) -> &Dialog<R> { unimplemented!() } }
impl<R: Runtime> Dialog<R> {
    pub fn message(&self, message: impl Into<String>) -> MessageDialogBuilder<R> { unimplemented!() }
    pub fn file(&self) -> FileDialogBuilder<R> { unimplemented!() }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> { unimplemented!() }
pub enum MessageDialogKind { Info, Warning, Error }
pub enum MessageDialogButtons { Ok, OkCancel, YesNo }
pub enum MessageDialogResult { Yes, No, Ok, Cancel, Custom(String) }
pub struct MessageDialogBuilder<R: Runtime>(std::marker::PhantomData<R>);
impl<R: Runtime> MessageDialogBuilder<R> {
    pub fn title(self, title: impl Into<String>) -> Self { unimplemented!() }
    pub fn kind(self, kind: MessageDialogKind) -> Self { unimplemented!() }
    pub fn buttons(self, buttons: MessageDialogButtons) -> Self { unimplemented!() }
    pub fn show<F: FnOnce(bool) + Send + 'static>(self, f: F) { unimplemented!() }
    pub fn show_with_result<F: FnOnce(MessageDialogResult) + Send + 'static>(self, f: F) { unimplemented!() }
    pub fn blocking_show(self) -> bool { unimplemented!() }
}
pub struct FileDialogBuilder<R: Runtime>(std::marker::PhantomData<R>);
impl<R: Runtime> FileDialogBuilder<R> {
    pub fn add_filter(self, name: impl Into<String>, extensions: &[&str]) -> Self { unimplemented!() }
    pub fn set_directory<P: AsRef<std::path::Path>>(self, directory: P) -> Self { unimplemented!() }
    pub fn set_file_name(self, file_name: impl Into<String>) -> Self { unimplemented!() }
    pub fn set_title(self, title: impl Into<String>) -> Self { unimplemented!() }
    pub fn pick_file<F: FnOnce(Option<FilePath>) + Send + 'static>(self, f: F) { unimplemented!() }
    pub fn blocking_pick_file(self) -> Option<FilePath> { unimplemented!() }
    pub fn pick_folder<F: FnOnce(Option<FilePath>) + Send + 'static>(self, f: F) { unimplemented!() }
    pub fn blocking_pick_folder(self) -> Option<FilePath> { unimplemented!() }
    pub fn save_file<F: FnOnce(Option<FilePath>) + Send + 'static>(self, f: F) { unimplemented!() }
    pub fn blocking_save_file(self) -> Option<FilePath> { unimplemented!() }
}
