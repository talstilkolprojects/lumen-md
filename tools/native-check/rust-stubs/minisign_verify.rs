//! Stub minisign-verify 0.3 (W11.S2); the API tauri-plugin-updater 2.14 calls
//! (plugins-workspace/plugins/updater/src/updater.rs `verify_signature`).
#[derive(Debug)]
pub struct Error;
impl std::fmt::Display for Error { fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("minisign error") } }
impl std::error::Error for Error {}
pub struct PublicKey;
impl PublicKey {
    pub fn decode(lines: &str) -> Result<PublicKey, Error> { unimplemented!() }
    pub fn from_base64(b64: &str) -> Result<PublicKey, Error> { unimplemented!() }
    pub fn verify(&self, bin: &[u8], signature: &Signature, allow_legacy: bool) -> Result<(), Error> { unimplemented!() }
}
pub struct Signature;
impl Signature { pub fn decode(lines: &str) -> Result<Signature, Error> { unimplemented!() } }
