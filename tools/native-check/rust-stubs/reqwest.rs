//! Stub reqwest 0.13 (W11.S2): the async client calls src-tauri/src/updates.rs makes.
#[derive(Debug)]
pub struct Error;
impl std::fmt::Display for Error { fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("reqwest error") } }
impl std::error::Error for Error {}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatusCode(u16);
impl StatusCode { pub const NOT_FOUND: StatusCode = StatusCode(404); pub const OK: StatusCode = StatusCode(200); }
pub struct Client;
pub struct ClientBuilder;
impl Client { pub fn builder() -> ClientBuilder { ClientBuilder } pub fn new() -> Client { Client } pub fn get<U: AsRef<str>>(&self, url: U) -> RequestBuilder { unimplemented!() } }
impl ClientBuilder { pub fn timeout(self, t: std::time::Duration) -> ClientBuilder { self } pub fn build(self) -> Result<Client, Error> { unimplemented!() } }
pub struct RequestBuilder;
impl RequestBuilder { pub async fn send(self) -> Result<Response, Error> { unimplemented!() } }
pub struct Response;
pub struct Bytes(Vec<u8>);
impl std::ops::Deref for Bytes { type Target = [u8]; fn deref(&self) -> &[u8] { &self.0 } }
impl Response {
    pub fn status(&self) -> StatusCode { unimplemented!() }
    pub fn error_for_status(self) -> Result<Response, Error> { unimplemented!() }
    pub async fn bytes(self) -> Result<Bytes, Error> { unimplemented!() }
}
