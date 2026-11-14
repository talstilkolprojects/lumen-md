//! Stub tauri-plugin-deep-link 2.6 (plan W4.23); signatures from plugins-workspace/plugins/deep-link/src/lib.rs.
use tauri::{plugin::TauriPlugin, EventId, Manager, Runtime};
use url::Url;
#[derive(Debug)]
pub struct Error;
impl std::fmt::Display for Error { fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("deep-link error") } }
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
pub struct DeepLink<R: Runtime>(std::marker::PhantomData<R>);
impl<R: Runtime> DeepLink<R> {
    pub fn get_current(&self) -> Result<Option<Vec<Url>>> { unimplemented!() }
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    pub fn register_all(&self) -> Result<()> { unimplemented!() }
    pub fn register<S: AsRef<str>>(&self, protocol: S) -> Result<()> { unimplemented!() }
    pub fn is_registered<S: AsRef<str>>(&self, protocol: S) -> Result<bool> { unimplemented!() }
    pub fn on_open_url<F: Fn(OpenUrlEvent) + Send + Sync + 'static>(&self, f: F) -> EventId { unimplemented!() }
}
pub trait DeepLinkExt<R: Runtime> { fn deep_link(&self) -> &DeepLink<R>; }
impl<R: Runtime, T: Manager<R>> DeepLinkExt<R> for T { fn deep_link(&self) -> &DeepLink<R> { unimplemented!() } }
pub struct OpenUrlEvent { id: EventId, urls: Vec<Url> }
impl OpenUrlEvent { pub fn id(&self) -> EventId { self.id } pub fn urls(self) -> Vec<Url> { self.urls } }
pub struct Config;
pub fn init<R: Runtime>() -> TauriPlugin<R, Option<Config>> { unimplemented!() }
