//! Stub tauri-plugin-fs 2 (plan W4.23).
use tauri::{plugin::TauriPlugin, Runtime};
use std::path::{Path, PathBuf};
#[derive(Debug)]
pub enum Error { InvalidPathUrl }
impl std::fmt::Display for Error { fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("fs error") } }
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone)]
pub enum FilePath { Url(url::Url), Path(PathBuf) }
impl FilePath {
    pub fn as_path(&self) -> Option<&Path> { unimplemented!() }
    pub fn into_path(self) -> Result<PathBuf> { unimplemented!() }
}
impl std::fmt::Display for FilePath { fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("") } }
pub struct Config;
pub fn init<R: Runtime>() -> TauriPlugin<R, Option<Config>> { unimplemented!() }
