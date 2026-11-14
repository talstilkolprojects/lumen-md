//! Stub `url` (plan W4.23).
use std::fmt;
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Url(String);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseError;
impl fmt::Display for ParseError { fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("invalid url") } }
impl std::error::Error for ParseError {}
impl std::str::FromStr for Url { type Err = ParseError; fn from_str(s: &str) -> Result<Self, ParseError> { Ok(Url(s.into())) } }
impl fmt::Display for Url { fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str(&self.0) } }
impl Url {
    pub fn parse(s: &str) -> Result<Url, ParseError> { Ok(Url(s.into())) }
    pub fn as_str(&self) -> &str { &self.0 }
    pub fn scheme(&self) -> &str { "" }
    pub fn host_str(&self) -> Option<&str> { None }
    pub fn path(&self) -> &str { "" }
    pub fn query(&self) -> Option<&str> { None }
    pub fn to_file_path(&self) -> Result<std::path::PathBuf, ()> { Err(()) }
    pub fn from_file_path<P: AsRef<std::path::Path>>(p: P) -> Result<Url, ()> { let _ = p; Err(()) }
}
impl serde::Serialize for Url {}
impl<'de> serde::Deserialize<'de> for Url {}
