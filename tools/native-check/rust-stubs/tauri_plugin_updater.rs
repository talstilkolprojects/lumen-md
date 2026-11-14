//! Stub tauri-plugin-updater 2.14 (plan W4.23); signatures from plugins-workspace/plugins/updater/src/{lib,updater}.rs.
use tauri::{plugin::TauriPlugin, Manager, Runtime};
use url::Url;
#[derive(Debug)]
pub struct Error;
impl std::fmt::Display for Error { fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("updater error") } }
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
pub trait UpdaterExt<R: Runtime> { fn updater_builder(&self) -> UpdaterBuilder; fn updater(&self) -> Result<Updater>; }
impl<R: Runtime, T: Manager<R>> UpdaterExt<R> for T { fn updater_builder(&self) -> UpdaterBuilder { unimplemented!() } fn updater(&self) -> Result<Updater> { unimplemented!() } }
pub struct UpdaterBuilder;
impl UpdaterBuilder {
    pub fn pubkey<S: Into<String>>(self, pubkey: S) -> Self { unimplemented!() }
    pub fn endpoints(self, endpoints: Vec<Url>) -> Result<Self> { unimplemented!() }
    pub fn target(self, target: impl Into<String>) -> Self { unimplemented!() }
    pub fn timeout(self, timeout: std::time::Duration) -> Self { unimplemented!() }
    pub fn build(self) -> Result<Updater> { unimplemented!() }
}
pub struct Updater;
impl Updater { pub async fn check(&self) -> Result<Option<Update>> { unimplemented!() } }
#[derive(Clone)]
pub struct Update { pub body: Option<String>, pub current_version: String, pub version: String, pub target: String, pub download_url: Url, pub signature: String, pub raw_json: serde_json::Value }
impl Update {
    pub async fn download<C: FnMut(usize, Option<u64>), D: FnOnce()>(&self, on_chunk: C, on_download_finish: D) -> Result<Vec<u8>> { unimplemented!() }
    pub fn install(&self, bytes: impl AsRef<[u8]>) -> Result<()> { unimplemented!() }
    pub async fn download_and_install<C: FnMut(usize, Option<u64>), D: FnOnce()>(&self, on_chunk: C, on_download_finish: D) -> Result<()> { unimplemented!() }
}
pub struct Config;
pub struct Builder;
impl Builder {
    pub fn new() -> Self { Builder }
    pub fn pubkey<S: Into<String>>(self, pubkey: S) -> Self { self }
    pub fn build<R: Runtime>(self) -> TauriPlugin<R, Config> { unimplemented!() }
}
impl Default for Builder { fn default() -> Self { Builder } }
