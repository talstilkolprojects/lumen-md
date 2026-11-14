//! Stub `serde_json` (plan W4.23).
use serde::{Deserialize, Serialize};
use std::fmt;
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value { #[default] Null, Bool(bool), Number(Number), String(String), Array(Vec<Value>), Object(Map<String, Value>) }
#[derive(Debug, Clone, PartialEq)]
pub struct Number;
pub type Map<K, V> = std::collections::BTreeMap<K, V>;
impl Serialize for Value {}
impl<'de> Deserialize<'de> for Value {}
impl Value {
    pub fn get<I: Index>(&self, index: I) -> Option<&Value> { let _ = index; None }
    pub fn as_str(&self) -> Option<&str> { None }
    pub fn as_array(&self) -> Option<&Vec<Value>> { None }
    pub fn as_object(&self) -> Option<&Map<String, Value>> { None }
    pub fn as_u64(&self) -> Option<u64> { None }
    pub fn as_i64(&self) -> Option<i64> { None }
    pub fn as_f64(&self) -> Option<f64> { None }
    pub fn as_bool(&self) -> Option<bool> { None }
    pub fn is_null(&self) -> bool { true }
}
impl fmt::Display for Value { fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("null") } }
pub trait Index {}
impl Index for &str {}
impl Index for String {}
impl Index for usize {}
#[derive(Debug)]
pub struct Error;
impl fmt::Display for Error { fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("json error") } }
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
pub fn from_str<'a, T: Deserialize<'a>>(s: &'a str) -> Result<T> { let _ = s; Err(Error) }
pub fn from_slice<'a, T: Deserialize<'a>>(s: &'a [u8]) -> Result<T> { let _ = s; Err(Error) }
pub fn from_value<T: serde::de::DeserializeOwned>(v: Value) -> Result<T> { let _ = v; Err(Error) }
pub fn to_string<T: ?Sized + Serialize>(v: &T) -> Result<String> { let _ = v; Ok(String::new()) }
pub fn to_string_pretty<T: ?Sized + Serialize>(v: &T) -> Result<String> { let _ = v; Ok(String::new()) }
pub fn to_vec<T: ?Sized + Serialize>(v: &T) -> Result<Vec<u8>> { let _ = v; Ok(Vec::new()) }
pub fn to_value<T: Serialize>(v: T) -> Result<Value> { let _ = v; Ok(Value::Null) }
#[doc(hidden)]
pub fn __json_value<T: Serialize + ?Sized>(_: &T) {}
/// Each interpolated value must be Serialize (as with the real macro).
#[macro_export]
macro_rules! json {
    ({ $($k:literal : $v:expr),* $(,)? }) => {{ $( $crate::__json_value(&$v); )* $crate::Value::Null }};
    ([ $($v:expr),* $(,)? ]) => {{ $( $crate::__json_value(&$v); )* $crate::Value::Null }};
    ($v:expr) => {{ $crate::__json_value(&$v); $crate::Value::Null }};
}
