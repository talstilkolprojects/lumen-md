//! Stub `tauri` 2.x for offline type-checking (plan W4.23).
//!
//! Signatures copied from tauri 2 (docs.rs/tauri/2) for exactly the API
//! surface Lumen's src-tauri uses; bodies are `unimplemented!()`. Linked
//! never, run never: only `rustc --emit=metadata` uses it.
#![allow(unused_variables, dead_code, clippy::all)]

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;

pub use tauri_macros::{command, mobile_entry_point};
pub use url::Url;

macro_rules! todo_ { () => { unimplemented!("tauri stub") } }

// ── runtime ────────────────────────────────────────────────────────────
pub trait Runtime: Send + Sync + Sized + 'static {}
pub struct Wry;
impl Runtime for Wry {}

// ── errors ─────────────────────────────────────────────────────────────
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    WindowNotFound,
    Io(std::io::Error),
    Anyhow(String),
}
impl fmt::Display for Error { fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("tauri error") } }
impl std::error::Error for Error {}
impl From<std::io::Error> for Error { fn from(e: std::io::Error) -> Self { Error::Io(e) } }
pub type Result<T> = std::result::Result<T, Error>;

// ── package / config / context ─────────────────────────────────────────
pub struct Version;
impl fmt::Display for Version { fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("0.0.0") } }
pub struct PackageInfo { pub name: String, pub version: Version, pub authors: &'static str, pub description: &'static str, pub crate_name: &'static str }
pub struct Config;
pub struct Context<R: Runtime = Wry>(std::marker::PhantomData<R>);
impl<R: Runtime> Context<R> { #[doc(hidden)] pub fn __stub() -> Self { Context(std::marker::PhantomData) } }

/// The real macro reads tauri.conf.json at compile time; checked separately.
#[macro_export]
macro_rules! generate_context { () => { $crate::Context::<$crate::Wry>::__stub() }; ($($t:tt)*) => { $crate::Context::<$crate::Wry>::__stub() }; }

/// Each listed command must exist and be visible from here (as with the
/// real macro, which calls the `__cmd__` macro next to each function).
#[macro_export]
macro_rules! generate_handler {
    ($($(#[$m:meta])* $p:path),* $(,)?) => {
        move |__invoke: $crate::ipc::Invoke<_>| -> bool { $( $(#[$m])* let _ = $p; )* let _ = __invoke; true }
    };
}

// ── dpi ────────────────────────────────────────────────────────────────
pub trait Pixel: Copy + Into<f64> {}
impl Pixel for i32 {}
impl Pixel for u32 {}
impl Pixel for f64 {}
#[derive(Debug, Copy, Clone, PartialEq, Default)]
pub struct PhysicalPosition<P> { pub x: P, pub y: P }
#[derive(Debug, Copy, Clone, PartialEq, Default)]
pub struct LogicalPosition<P> { pub x: P, pub y: P }
#[derive(Debug, Copy, Clone, PartialEq, Default)]
pub struct PhysicalSize<P> { pub width: P, pub height: P }
#[derive(Debug, Copy, Clone, PartialEq, Default)]
pub struct LogicalSize<P> { pub width: P, pub height: P }
impl<P> PhysicalPosition<P> { pub const fn new(x: P, y: P) -> Self { Self { x, y } } }
impl<P> LogicalPosition<P> { pub const fn new(x: P, y: P) -> Self { Self { x, y } } }
#[derive(Debug, Copy, Clone, PartialEq)]
pub enum Position { Physical(PhysicalPosition<i32>), Logical(LogicalPosition<f64>) }
impl<P: Pixel> From<PhysicalPosition<P>> for Position { fn from(p: PhysicalPosition<P>) -> Self { todo_!() } }
impl<P: Pixel> From<LogicalPosition<P>> for Position { fn from(p: LogicalPosition<P>) -> Self { todo_!() } }
#[derive(Debug, Copy, Clone, PartialEq)]
pub enum Size { Physical(PhysicalSize<u32>), Logical(LogicalSize<f64>) }
impl<P: Pixel> From<PhysicalSize<P>> for Size { fn from(p: PhysicalSize<P>) -> Self { todo_!() } }
impl<P: Pixel> From<LogicalSize<P>> for Size { fn from(p: LogicalSize<P>) -> Self { todo_!() } }
pub mod dpi { pub use super::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize, Pixel, Position, Size}; }

#[derive(Debug, Clone, PartialEq)]
pub struct Monitor;
impl Monitor {
    pub fn name(&self) -> Option<&String> { todo_!() }
    pub fn size(&self) -> &PhysicalSize<u32> { todo_!() }
    pub fn position(&self) -> &PhysicalPosition<i32> { todo_!() }
    pub fn scale_factor(&self) -> f64 { todo_!() }
}

// ── image ──────────────────────────────────────────────────────────────
pub mod image {
    #[derive(Debug, Clone)]
    pub struct Image<'a>(std::borrow::Cow<'a, [u8]>);
    impl<'a> Image<'a> {
        pub fn to_owned(self) -> Image<'static> { unimplemented!() }
        pub fn width(&self) -> u32 { unimplemented!() }
    }
}

// ── events ─────────────────────────────────────────────────────────────
pub type EventId = u32;
#[derive(Debug, Clone)]
pub enum EventTarget { Any, AnyLabel { label: String }, App, Window { label: String }, Webview { label: String }, WebviewWindow { label: String } }
impl From<&str> for EventTarget { fn from(s: &str) -> Self { todo_!() } }
impl From<String> for EventTarget { fn from(s: String) -> Self { todo_!() } }
impl From<&String> for EventTarget { fn from(s: &String) -> Self { todo_!() } }
pub struct Event;
impl Event { pub fn id(&self) -> EventId { todo_!() } pub fn payload(&self) -> &str { todo_!() } }

pub trait Emitter<R: Runtime>: sealed::ManagerBase<R> {
    fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> Result<()> { todo_!() }
    fn emit_str(&self, event: &str, payload: String) -> Result<()> { todo_!() }
    fn emit_to<I, S>(&self, target: I, event: &str, payload: S) -> Result<()>
    where I: Into<EventTarget>, S: serde::Serialize + Clone { todo_!() }
    fn emit_filter<S, F>(&self, event: &str, payload: S, filter: F) -> Result<()>
    where S: serde::Serialize + Clone, F: Fn(&EventTarget) -> bool { todo_!() }
}
pub trait Listener<R: Runtime>: sealed::ManagerBase<R> {
    fn listen<F>(&self, event: impl Into<String>, handler: F) -> EventId where F: Fn(Event) + Send + 'static { todo_!() }
    fn unlisten(&self, id: EventId) { todo_!() }
}

mod sealed {
    pub trait ManagerBase<R: super::Runtime> {}
}

// ── state ──────────────────────────────────────────────────────────────
pub struct State<'r, T: Send + Sync + 'static>(&'r T);
impl<'r, T: Send + Sync + 'static> State<'r, T> { pub fn inner(&self) -> &'r T { self.0 } }
impl<T: Send + Sync + 'static> std::ops::Deref for State<'_, T> { type Target = T; fn deref(&self) -> &T { self.0 } }
impl<T: Send + Sync + 'static> Clone for State<'_, T> { fn clone(&self) -> Self { State(self.0) } }
impl<T: Send + Sync + 'static> Copy for State<'_, T> {}

// ── path ───────────────────────────────────────────────────────────────
pub mod path {
    use super::*;
    pub struct PathResolver<R: Runtime>(std::marker::PhantomData<R>);
    impl<R: Runtime> PathResolver<R> {
        pub fn app_config_dir(&self) -> Result<PathBuf> { todo_!() }
        pub fn app_data_dir(&self) -> Result<PathBuf> { todo_!() }
        pub fn app_local_data_dir(&self) -> Result<PathBuf> { todo_!() }
        pub fn app_cache_dir(&self) -> Result<PathBuf> { todo_!() }
        pub fn app_log_dir(&self) -> Result<PathBuf> { todo_!() }
        pub fn resource_dir(&self) -> Result<PathBuf> { todo_!() }
        pub fn temp_dir(&self) -> Result<PathBuf> { todo_!() }
        pub fn home_dir(&self) -> Result<PathBuf> { todo_!() }
        pub fn document_dir(&self) -> Result<PathBuf> { todo_!() }
    }
}

// ── manager ────────────────────────────────────────────────────────────
pub trait Manager<R: Runtime>: sealed::ManagerBase<R> {
    fn app_handle(&self) -> &AppHandle<R> { todo_!() }
    fn config(&self) -> &Config { todo_!() }
    fn package_info(&self) -> &PackageInfo { todo_!() }
    fn get_window(&self, label: &str) -> Option<Window<R>> { todo_!() }
    fn get_focused_window(&self) -> Option<Window<R>> { todo_!() }
    fn windows(&self) -> HashMap<String, Window<R>> { todo_!() }
    fn get_webview_window(&self, label: &str) -> Option<WebviewWindow<R>> { todo_!() }
    fn webview_windows(&self) -> HashMap<String, WebviewWindow<R>> { todo_!() }
    fn manage<T>(&self, state: T) -> bool where T: Send + Sync + 'static { todo_!() }
    fn state<T>(&self) -> State<'_, T> where T: Send + Sync + 'static { todo_!() }
    fn try_state<T>(&self) -> Option<State<'_, T>> where T: Send + Sync + 'static { todo_!() }
    fn path(&self) -> &path::PathResolver<R> { todo_!() }
}

macro_rules! manager_for { ($($t:ident),*) => { $(
    impl<R: Runtime> sealed::ManagerBase<R> for $t<R> {}
    impl<R: Runtime> Manager<R> for $t<R> {}
    impl<R: Runtime> Emitter<R> for $t<R> {}
    impl<R: Runtime> Listener<R> for $t<R> {}
)* } }
manager_for!(App, AppHandle, Window, WebviewWindow, Webview);

// ── app ────────────────────────────────────────────────────────────────
pub struct App<R: Runtime = Wry>(std::marker::PhantomData<R>);
pub struct AppHandle<R: Runtime = Wry>(std::marker::PhantomData<R>);
impl<R: Runtime> Clone for AppHandle<R> { fn clone(&self) -> Self { todo_!() } }

macro_rules! app_common { () => {
    /// Inherent in tauri 2 (plugins-workspace/plugins/updater/src/updater.rs calls it without `Manager`).
    pub fn package_info(&self) -> &PackageInfo { todo_!() }
    pub fn config(&self) -> &Config { todo_!() }
    pub fn default_window_icon(&self) -> Option<&image::Image<'_>> { todo_!() }
    pub fn set_menu(&self, menu: menu::Menu<R>) -> Result<Option<menu::Menu<R>>> { todo_!() }
    pub fn menu(&self) -> Option<menu::Menu<R>> { todo_!() }
    pub fn remove_menu(&self) -> Result<Option<menu::Menu<R>>> { todo_!() }
    pub fn on_menu_event<F: Fn(&AppHandle<R>, menu::MenuEvent) + Send + Sync + 'static>(&self, handler: F) { todo_!() }
    #[cfg(feature = "tray-icon")]
    pub fn tray_by_id<'a, I>(&self, id: &'a I) -> Option<tray::TrayIcon<R>> where I: ?Sized, tray::TrayIconId: PartialEq<&'a I> { todo_!() }
    pub fn primary_monitor(&self) -> Result<Option<Monitor>> { todo_!() }
    pub fn available_monitors(&self) -> Result<Vec<Monitor>> { todo_!() }
    pub fn monitor_from_point(&self, x: f64, y: f64) -> Result<Option<Monitor>> { todo_!() }
    pub fn cursor_position(&self) -> Result<PhysicalPosition<f64>> { todo_!() }
}}
impl<R: Runtime> App<R> {
    pub fn handle(&self) -> &AppHandle<R> { todo_!() }
    pub fn run<F: FnMut(&AppHandle<R>, RunEvent) + 'static>(self, callback: F) { todo_!() }
    pub fn run_return<F: FnMut(&AppHandle<R>, RunEvent) + 'static>(self, callback: F) -> i32 { todo_!() }
    app_common!();
}
impl<R: Runtime> AppHandle<R> {
    pub fn exit(&self, exit_code: i32) { todo_!() }
    pub fn restart(&self) -> ! { todo_!() }
    pub fn request_restart(&self) { todo_!() }
    pub fn plugin<P: plugin::Plugin<R> + 'static>(&self, plugin: P) -> Result<()> { todo_!() }
    app_common!();
}

#[non_exhaustive]
pub enum RunEvent {
    Exit,
    #[non_exhaustive]
    ExitRequested { code: Option<i32>, api: ExitRequestApi },
    #[non_exhaustive]
    WindowEvent { label: String, event: WindowEvent },
    Ready,
    Resumed,
    MainEventsCleared,
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    Opened { urls: Vec<Url> },
    #[cfg(target_os = "macos")]
    Reopen { has_visible_windows: bool },
}
pub struct ExitRequestApi;
impl ExitRequestApi { pub fn prevent_exit(&self) {} }
pub struct CloseRequestApi;
impl CloseRequestApi { pub fn prevent_close(&self) {} }

#[non_exhaustive]
pub enum WindowEvent {
    Resized(PhysicalSize<u32>),
    Moved(PhysicalPosition<i32>),
    #[non_exhaustive]
    CloseRequested { api: CloseRequestApi },
    Destroyed,
    Focused(bool),
    #[non_exhaustive]
    ScaleFactorChanged { scale_factor: f64, new_inner_size: PhysicalSize<u32> },
    DragDrop(DragDropEvent),
}
#[non_exhaustive]
pub enum DragDropEvent { Enter { paths: Vec<PathBuf>, position: PhysicalPosition<f64> }, Over { position: PhysicalPosition<f64> }, Drop { paths: Vec<PathBuf>, position: PhysicalPosition<f64> }, Leave }

// ── builder ────────────────────────────────────────────────────────────
pub struct Builder<R: Runtime = Wry>(std::marker::PhantomData<R>);
impl Default for Builder<Wry> { fn default() -> Self { todo_!() } }
impl<R: Runtime> Builder<R> {
    pub fn new() -> Self { todo_!() }
    pub fn invoke_handler<F>(self, invoke_handler: F) -> Self where F: Fn(ipc::Invoke<R>) -> bool + Send + Sync + 'static { todo_!() }
    pub fn setup<F>(self, setup: F) -> Self where F: FnOnce(&mut App<R>) -> std::result::Result<(), Box<dyn std::error::Error>> + Send + 'static { todo_!() }
    pub fn plugin<P: plugin::Plugin<R> + 'static>(self, plugin: P) -> Self { todo_!() }
    pub fn manage<T>(self, state: T) -> Self where T: Send + Sync + 'static { todo_!() }
    pub fn menu<F: FnOnce(&AppHandle<R>) -> Result<menu::Menu<R>> + 'static>(self, f: F) -> Self { todo_!() }
    pub fn on_menu_event<F: Fn(&AppHandle<R>, menu::MenuEvent) + Send + Sync + 'static>(self, f: F) -> Self { todo_!() }
    pub fn on_window_event<F: Fn(&Window<R>, &WindowEvent) + Send + Sync + 'static>(self, handler: F) -> Self { todo_!() }
    pub fn build(self, context: Context<R>) -> Result<App<R>> { todo_!() }
    pub fn run(self, context: Context<R>) -> Result<()> { todo_!() }
}

// ── windows ────────────────────────────────────────────────────────────
pub struct Window<R: Runtime = Wry>(std::marker::PhantomData<R>);
pub struct WebviewWindow<R: Runtime = Wry>(std::marker::PhantomData<R>);
pub struct Webview<R: Runtime = Wry>(std::marker::PhantomData<R>);
impl<R: Runtime> Clone for Window<R> { fn clone(&self) -> Self { todo_!() } }
impl<R: Runtime> Clone for WebviewWindow<R> { fn clone(&self) -> Self { todo_!() } }

macro_rules! window_common { () => {
    pub fn label(&self) -> &str { todo_!() }
    pub fn show(&self) -> Result<()> { todo_!() }
    pub fn hide(&self) -> Result<()> { todo_!() }
    pub fn close(&self) -> Result<()> { todo_!() }
    pub fn destroy(&self) -> Result<()> { todo_!() }
    pub fn set_focus(&self) -> Result<()> { todo_!() }
    pub fn minimize(&self) -> Result<()> { todo_!() }
    pub fn unminimize(&self) -> Result<()> { todo_!() }
    pub fn maximize(&self) -> Result<()> { todo_!() }
    pub fn set_title(&self, title: &str) -> Result<()> { todo_!() }
    pub fn set_fullscreen(&self, fullscreen: bool) -> Result<()> { todo_!() }
    pub fn is_fullscreen(&self) -> Result<bool> { todo_!() }
    pub fn is_minimized(&self) -> Result<bool> { todo_!() }
    pub fn is_maximized(&self) -> Result<bool> { todo_!() }
    pub fn is_focused(&self) -> Result<bool> { todo_!() }
    pub fn is_visible(&self) -> Result<bool> { todo_!() }
    pub fn set_position<Pos: Into<Position>>(&self, position: Pos) -> Result<()> { todo_!() }
    pub fn set_size<S: Into<Size>>(&self, size: S) -> Result<()> { todo_!() }
    pub fn outer_position(&self) -> Result<PhysicalPosition<i32>> { todo_!() }
    pub fn inner_position(&self) -> Result<PhysicalPosition<i32>> { todo_!() }
    pub fn outer_size(&self) -> Result<PhysicalSize<u32>> { todo_!() }
    pub fn inner_size(&self) -> Result<PhysicalSize<u32>> { todo_!() }
    pub fn scale_factor(&self) -> Result<f64> { todo_!() }
    pub fn current_monitor(&self) -> Result<Option<Monitor>> { todo_!() }
    pub fn primary_monitor(&self) -> Result<Option<Monitor>> { todo_!() }
    pub fn available_monitors(&self) -> Result<Vec<Monitor>> { todo_!() }
    pub fn cursor_position(&self) -> Result<PhysicalPosition<f64>> { todo_!() }
    pub fn set_menu(&self, menu: menu::Menu<R>) -> Result<Option<menu::Menu<R>>> { todo_!() }
}}
impl<R: Runtime> Window<R> { window_common!(); }
impl<R: Runtime> WebviewWindow<R> {
    window_common!();
    pub fn eval(&self, js: impl Into<String>) -> Result<()> { todo_!() }
    pub fn as_ref(&self) -> &Webview<R> { todo_!() }
}
impl<R: Runtime> Webview<R> { pub fn label(&self) -> &str { todo_!() } pub fn window(&self) -> Window<R> { todo_!() } }

pub mod webview {
    use super::*;
    pub enum WebviewUrl { External(Url), App(PathBuf), CustomProtocol(Url) }
    pub struct WebviewWindowBuilder<'a, R: Runtime, M: Manager<R>>(&'a M, std::marker::PhantomData<R>);
    impl<'a, R: Runtime, M: Manager<R>> WebviewWindowBuilder<'a, R, M> {
        pub fn new<L: Into<String>>(manager: &'a M, label: L, url: WebviewUrl) -> Self { todo_!() }
        pub fn title<S: Into<String>>(self, title: S) -> Self { todo_!() }
        pub fn inner_size(self, width: f64, height: f64) -> Self { todo_!() }
        pub fn min_inner_size(self, min_width: f64, min_height: f64) -> Self { todo_!() }
        pub fn max_inner_size(self, max_width: f64, max_height: f64) -> Self { todo_!() }
        pub fn position(self, x: f64, y: f64) -> Self { todo_!() }
        pub fn center(self) -> Self { todo_!() }
        pub fn resizable(self, resizable: bool) -> Self { todo_!() }
        pub fn always_on_top(self, always_on_top: bool) -> Self { todo_!() }
        pub fn decorations(self, decorations: bool) -> Self { todo_!() }
        pub fn fullscreen(self, fullscreen: bool) -> Self { todo_!() }
        pub fn focused(self, focused: bool) -> Self { todo_!() }
        pub fn visible(self, visible: bool) -> Self { todo_!() }
        pub fn skip_taskbar(self, skip: bool) -> Self { todo_!() }
        pub fn build(self) -> Result<WebviewWindow<R>> { todo_!() }
    }
}
pub use webview::{WebviewUrl, WebviewWindowBuilder};

// ── ipc ────────────────────────────────────────────────────────────────
pub mod ipc {
    use super::*;
    pub struct Invoke<R: Runtime = Wry>(std::marker::PhantomData<R>);
    pub struct InvokeError(serde_json::Value);
    impl<T: serde::Serialize> From<T> for InvokeError { fn from(value: T) -> Self { todo_!() } }
    pub enum InvokeBody { Json(serde_json::Value), Raw(Vec<u8>) }
    pub enum InvokeResponseBody { Json(String), Raw(Vec<u8>) }
    impl From<Vec<u8>> for InvokeResponseBody { fn from(v: Vec<u8>) -> Self { InvokeResponseBody::Raw(v) } }
    impl From<String> for InvokeResponseBody { fn from(v: String) -> Self { InvokeResponseBody::Json(v) } }
    impl From<&[u8]> for InvokeResponseBody { fn from(v: &[u8]) -> Self { InvokeResponseBody::Raw(v.to_vec()) } }
    pub struct Response(InvokeResponseBody);
    impl Response { pub fn new(body: impl Into<InvokeResponseBody>) -> Self { Response(body.into()) } }
    pub struct HeaderMap;
    pub struct HeaderValue;
    #[derive(Debug)]
    pub struct ToStrError;
    impl fmt::Display for ToStrError { fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("not ascii") } }
    pub trait AsHeaderName {}
    impl AsHeaderName for &str {}
    impl AsHeaderName for String {}
    impl AsHeaderName for &String {}
    impl HeaderMap {
        pub fn get<K: AsHeaderName>(&self, key: K) -> Option<&HeaderValue> { todo_!() }
        pub fn contains_key<K: AsHeaderName>(&self, key: K) -> bool { todo_!() }
    }
    impl HeaderValue {
        pub fn to_str(&self) -> std::result::Result<&str, ToStrError> { todo_!() }
        pub fn as_bytes(&self) -> &[u8] { todo_!() }
    }
    pub struct Request<'a> { body: &'a InvokeBody, headers: &'a HeaderMap }
    impl<'a> Request<'a> {
        pub fn body(&self) -> &InvokeBody { self.body }
        pub fn headers(&self) -> &HeaderMap { self.headers }
    }
    pub struct Channel<T = InvokeResponseBody>(std::marker::PhantomData<T>);
    impl<T> Channel<T> { pub fn send(&self, data: T) -> Result<()> { todo_!() } }

    /// What a command may take (tauri::ipc::CommandArg).
    pub trait CommandArg<'de, R: Runtime>: Sized {}
    impl<'de, D: serde::Deserialize<'de>, R: Runtime> CommandArg<'de, R> for D {}
    impl<'r, 'de: 'r, T: Send + Sync + 'static, R: Runtime> CommandArg<'de, R> for State<'r, T> {}
    impl<'de, R: Runtime> CommandArg<'de, R> for AppHandle<R> {}
    impl<'de, R: Runtime> CommandArg<'de, R> for Window<R> {}
    impl<'de, R: Runtime> CommandArg<'de, R> for WebviewWindow<R> {}
    impl<'de, R: Runtime> CommandArg<'de, R> for Webview<R> {}
    impl<'a, R: Runtime> CommandArg<'a, R> for Request<'a> {}
    impl<'de, R: Runtime, T> CommandArg<'de, R> for Channel<T> {}

    /// What a command may return (tauri::ipc::IpcResponse).
    pub trait IpcResponse {}
    impl<T: serde::Serialize> IpcResponse for T {}
    impl IpcResponse for Response {}
}

// ── async runtime ──────────────────────────────────────────────────────
pub mod async_runtime {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    pub struct JoinHandle<T>(std::marker::PhantomData<T>);
    impl<T> Future for JoinHandle<T> {
        type Output = super::Result<T>;
        fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> { todo_!() }
    }
    impl<T> JoinHandle<T> { pub fn abort(&self) {} }
    pub fn spawn<F>(task: F) -> JoinHandle<F::Output> where F: Future + Send + 'static, F::Output: Send + 'static { todo_!() }
    pub fn spawn_blocking<F, R>(func: F) -> JoinHandle<R> where F: FnOnce() -> R + Send + 'static, R: Send + 'static { todo_!() }
    pub fn block_on<F: Future>(task: F) -> F::Output { todo_!() }
}

// ── plugins ────────────────────────────────────────────────────────────
pub mod plugin {
    use super::*;
    pub trait Plugin<R: Runtime>: Send {}
    pub struct TauriPlugin<R: Runtime, C = ()>(std::marker::PhantomData<(R, C)>);
    unsafe impl<R: Runtime, C> Send for TauriPlugin<R, C> {}
    impl<R: Runtime, C: 'static> Plugin<R> for TauriPlugin<R, C> {}
    pub struct Builder<R: Runtime, C = ()>(std::marker::PhantomData<(R, C)>);
}

// ── menu ───────────────────────────────────────────────────────────────
pub mod menu {
    use super::*;
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub struct MenuId(pub String);
    impl<T: ToString> From<T> for MenuId { fn from(value: T) -> Self { MenuId(value.to_string()) } }
    impl MenuId { pub fn as_ref(&self) -> &str { &self.0 } }
    #[derive(Debug, Clone)]
    pub struct MenuEvent { pub id: MenuId }
    impl MenuEvent { pub fn id(&self) -> &MenuId { &self.id } }

    pub trait IsMenuItem<R: Runtime>: Send + Sync {}
    pub trait ContextMenu: Send + Sync {}

    pub struct Menu<R: Runtime = Wry>(std::marker::PhantomData<R>);
    pub struct Submenu<R: Runtime = Wry>(std::marker::PhantomData<R>);
    pub struct MenuItem<R: Runtime = Wry>(std::marker::PhantomData<R>);
    pub struct PredefinedMenuItem<R: Runtime = Wry>(std::marker::PhantomData<R>);
    pub struct CheckMenuItem<R: Runtime = Wry>(std::marker::PhantomData<R>);
    impl<R: Runtime> Clone for Menu<R> { fn clone(&self) -> Self { todo_!() } }
    impl<R: Runtime> IsMenuItem<R> for Submenu<R> {}
    impl<R: Runtime> IsMenuItem<R> for MenuItem<R> {}
    impl<R: Runtime> IsMenuItem<R> for PredefinedMenuItem<R> {}
    impl<R: Runtime> IsMenuItem<R> for CheckMenuItem<R> {}
    impl<R: Runtime> ContextMenu for Menu<R> {}
    impl<R: Runtime> ContextMenu for Submenu<R> {}

    impl<R: Runtime> Menu<R> {
        pub fn new<M: Manager<R>>(manager: &M) -> Result<Self> { todo_!() }
        pub fn append(&self, item: &dyn IsMenuItem<R>) -> Result<()> { todo_!() }
    }
    impl<R: Runtime> MenuItem<R> {
        pub fn id(&self) -> &MenuId { todo_!() }
        pub fn set_text<S: AsRef<str>>(&self, text: S) -> Result<()> { todo_!() }
        pub fn set_enabled(&self, enabled: bool) -> Result<()> { todo_!() }
    }

    #[derive(Debug, Clone, Default)]
    pub struct AboutMetadata<'a> {
        pub name: Option<String>,
        pub version: Option<String>,
        pub short_version: Option<String>,
        pub authors: Option<Vec<String>>,
        pub comments: Option<String>,
        pub copyright: Option<String>,
        pub license: Option<String>,
        pub website: Option<String>,
        pub website_label: Option<String>,
        pub credits: Option<String>,
        pub icon: Option<image::Image<'a>>,
    }
    #[derive(Debug, Clone, Default)]
    pub struct AboutMetadataBuilder<'a>(AboutMetadata<'a>);
    impl<'a> AboutMetadataBuilder<'a> {
        pub fn new() -> Self { Default::default() }
        pub fn name<S: Into<String>>(self, name: Option<S>) -> Self { todo_!() }
        pub fn version<S: Into<String>>(self, version: Option<S>) -> Self { todo_!() }
        pub fn short_version<S: Into<String>>(self, v: Option<S>) -> Self { todo_!() }
        pub fn authors(self, authors: Option<Vec<String>>) -> Self { todo_!() }
        pub fn comments<S: Into<String>>(self, c: Option<S>) -> Self { todo_!() }
        pub fn copyright<S: Into<String>>(self, copyright: Option<S>) -> Self { todo_!() }
        pub fn license<S: Into<String>>(self, license: Option<S>) -> Self { todo_!() }
        pub fn website<S: Into<String>>(self, website: Option<S>) -> Self { todo_!() }
        pub fn website_label<S: Into<String>>(self, l: Option<S>) -> Self { todo_!() }
        pub fn credits<S: Into<String>>(self, c: Option<S>) -> Self { todo_!() }
        pub fn icon(self, icon: Option<image::Image<'a>>) -> Self { todo_!() }
        pub fn build(self) -> AboutMetadata<'a> { self.0 }
    }

    impl<R: Runtime> PredefinedMenuItem<R> {
        pub fn separator<M: Manager<R>>(manager: &M) -> Result<Self> { todo_!() }
        pub fn copy<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn cut<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn paste<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn select_all<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn undo<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn redo<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn minimize<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn maximize<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn fullscreen<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn hide<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn hide_others<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn show_all<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn close_window<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn quit<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
        pub fn about<M: Manager<R>>(manager: &M, text: Option<&str>, metadata: Option<AboutMetadata<'_>>) -> Result<Self> { todo_!() }
        pub fn services<M: Manager<R>>(manager: &M, text: Option<&str>) -> Result<Self> { todo_!() }
    }

    pub struct MenuItemBuilder { id: Option<MenuId>, text: String, enabled: bool, accelerator: Option<String> }
    impl MenuItemBuilder {
        pub fn new<S: AsRef<str>>(text: S) -> Self { todo_!() }
        pub fn with_id<I: Into<MenuId>, S: AsRef<str>>(id: I, text: S) -> Self { todo_!() }
        pub fn id<I: Into<MenuId>>(self, id: I) -> Self { todo_!() }
        pub fn accelerator<A: AsRef<str>>(self, accelerator: A) -> Self { todo_!() }
        pub fn enabled(self, enabled: bool) -> Self { todo_!() }
        pub fn build<R: Runtime, M: Manager<R>>(self, manager: &M) -> Result<MenuItem<R>> { todo_!() }
    }

    pub struct MenuBuilder<'m, R: Runtime, M: Manager<R>>(&'m M, std::marker::PhantomData<R>);
    impl<'m, R: Runtime, M: Manager<R>> MenuBuilder<'m, R, M> {
        pub fn new(manager: &'m M) -> Self { todo_!() }
        pub fn with_id<I: Into<MenuId>>(manager: &'m M, id: I) -> Self { todo_!() }
        pub fn item(self, item: &dyn IsMenuItem<R>) -> Self { todo_!() }
        pub fn items(self, items: &[&dyn IsMenuItem<R>]) -> Self { todo_!() }
        pub fn text<I: Into<MenuId>, S: AsRef<str>>(self, id: I, text: S) -> Self { todo_!() }
        pub fn separator(self) -> Self { todo_!() }
        pub fn build(self) -> Result<Menu<R>> { todo_!() }
    }
    pub struct SubmenuBuilder<'m, R: Runtime, M: Manager<R>>(&'m M, std::marker::PhantomData<R>);
    impl<'m, R: Runtime, M: Manager<R>> SubmenuBuilder<'m, R, M> {
        pub fn new<S: AsRef<str>>(manager: &'m M, text: S) -> Self { todo_!() }
        pub fn with_id<I: Into<MenuId>, S: AsRef<str>>(manager: &'m M, id: I, text: S) -> Self { todo_!() }
        pub fn item(self, item: &dyn IsMenuItem<R>) -> Self { todo_!() }
        pub fn items(self, items: &[&dyn IsMenuItem<R>]) -> Self { todo_!() }
        pub fn text<I: Into<MenuId>, S: AsRef<str>>(self, id: I, text: S) -> Self { todo_!() }
        pub fn separator(self) -> Self { todo_!() }
        pub fn enabled(self, enabled: bool) -> Self { todo_!() }
        pub fn build(self) -> Result<Submenu<R>> { todo_!() }
    }
}

// ── tray (feature "tray-icon") ─────────────────────────────────────────
#[cfg(feature = "tray-icon")]
pub mod tray {
    use super::*;
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub struct TrayIconId(pub String);
    impl<T: ToString> From<T> for TrayIconId { fn from(value: T) -> Self { TrayIconId(value.to_string()) } }
    impl PartialEq<&str> for TrayIconId { fn eq(&self, other: &&str) -> bool { self.0 == *other } }
    impl PartialEq<&String> for TrayIconId { fn eq(&self, other: &&String) -> bool { &self.0 == *other } }
    pub enum TrayIconEvent { Click { id: TrayIconId }, DoubleClick { id: TrayIconId }, Enter { id: TrayIconId }, Move { id: TrayIconId }, Leave { id: TrayIconId } }
    pub struct TrayIcon<R: Runtime = Wry>(std::marker::PhantomData<R>);
    impl<R: Runtime> Clone for TrayIcon<R> { fn clone(&self) -> Self { todo_!() } }
    impl<R: Runtime> TrayIcon<R> {
        pub fn id(&self) -> &TrayIconId { todo_!() }
        pub fn set_menu<M: menu::ContextMenu + 'static>(&self, menu: Option<M>) -> Result<()> { todo_!() }
        pub fn set_tooltip<S: AsRef<str>>(&self, tooltip: Option<S>) -> Result<()> { todo_!() }
        pub fn set_icon(&self, icon: Option<image::Image<'_>>) -> Result<()> { todo_!() }
        pub fn set_visible(&self, visible: bool) -> Result<()> { todo_!() }
    }
    pub struct TrayIconBuilder<R: Runtime>(std::marker::PhantomData<R>);
    impl<R: Runtime> TrayIconBuilder<R> {
        pub fn new() -> Self { todo_!() }
        pub fn with_id<I: Into<TrayIconId>>(id: I) -> Self { todo_!() }
        pub fn menu<M: menu::ContextMenu>(self, menu: &M) -> Self { todo_!() }
        pub fn icon(self, icon: image::Image<'_>) -> Self { todo_!() }
        pub fn tooltip<S: AsRef<str>>(self, s: S) -> Self { todo_!() }
        pub fn title<S: AsRef<str>>(self, title: S) -> Self { todo_!() }
        pub fn icon_as_template(self, is_template: bool) -> Self { todo_!() }
        pub fn show_menu_on_left_click(self, enable: bool) -> Self { todo_!() }
        pub fn on_menu_event<F: Fn(&AppHandle<R>, menu::MenuEvent) + Sync + Send + 'static>(self, f: F) -> Self { todo_!() }
        pub fn on_tray_icon_event<F: Fn(&TrayIcon<R>, TrayIconEvent) + Sync + Send + 'static>(self, f: F) -> Self { todo_!() }
        pub fn build<M: Manager<R>>(self, manager: &M) -> Result<TrayIcon<R>> { todo_!() }
    }
}
