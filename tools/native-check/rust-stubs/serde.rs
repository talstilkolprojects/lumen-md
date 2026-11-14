//! Stub `serde` for offline type-checking (plan W4.23): the traits and
//! which std types implement them, nothing else.
pub use serde_derive::{Deserialize, Serialize};
pub trait Serialize {}
pub trait Deserialize<'de>: Sized {}
pub mod de {
    pub trait DeserializeOwned: for<'de> super::Deserialize<'de> {}
    impl<T> DeserializeOwned for T where T: for<'de> super::Deserialize<'de> {}
    pub use super::Deserialize;
}
pub mod ser { pub use super::Serialize; }
macro_rules! both { ($($t:ty),*) => { $( impl Serialize for $t {} impl<'de> Deserialize<'de> for $t {} )* } }
both!(bool, u8, u16, u32, u64, u128, usize, i8, i16, i32, i64, i128, isize, f32, f64, char, String, (), std::path::PathBuf);
impl Serialize for str {}
impl Serialize for std::path::Path {}
impl<'de: 'a, 'a> Deserialize<'de> for &'a str {}
impl<T: Serialize + ?Sized> Serialize for &T {}
impl<T: Serialize + ?Sized> Serialize for &mut T {}
impl<T: Serialize + ?Sized> Serialize for Box<T> {}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Box<T> {}
impl<T: Serialize> Serialize for Option<T> {}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Option<T> {}
impl<T: Serialize> Serialize for Vec<T> {}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Vec<T> {}
impl<T: Serialize> Serialize for [T] {}
impl<T: Serialize, const N: usize> Serialize for [T; N] {}
impl<T: Serialize, E: Serialize> Serialize for Result<T, E> {}
impl<K: Serialize, V: Serialize, S> Serialize for std::collections::HashMap<K, V, S> {}
impl<'de, K: Deserialize<'de> + Eq + std::hash::Hash, V: Deserialize<'de>> Deserialize<'de> for std::collections::HashMap<K, V> {}
impl<K: Serialize, V: Serialize> Serialize for std::collections::BTreeMap<K, V> {}
impl<'de, K: Deserialize<'de> + Ord, V: Deserialize<'de>> Deserialize<'de> for std::collections::BTreeMap<K, V> {}
impl<T: Serialize + ?Sized> Serialize for std::sync::Arc<T> {}
impl<T: Serialize + ToOwned + ?Sized> Serialize for std::borrow::Cow<'_, T> {}
macro_rules! tup { ($($n:ident),+) => { impl<$($n: Serialize),+> Serialize for ($($n,)+) {} impl<'de, $($n: Deserialize<'de>),+> Deserialize<'de> for ($($n,)+) {} } }
tup!(A); tup!(A, B); tup!(A, B, C); tup!(A, B, C, D);
