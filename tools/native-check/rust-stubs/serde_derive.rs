//! Stub `serde_derive` for offline type-checking (plan W4.23).
//! Emits `impl Serialize/Deserialize for T {}` and, like the real derive,
//! requires every (non-skipped) field type to implement the trait.
extern crate proc_macro;
use proc_macro::{Delimiter, TokenStream, TokenTree};

fn is_punct(t: &TokenTree, c: char) -> bool {
    matches!(t, TokenTree::Punct(p) if p.as_char() == c)
}

/// Split a token list at top-level commas (tracking `<` `>` depth).
fn split_commas(toks: &[TokenTree]) -> Vec<Vec<TokenTree>> {
    let mut out = vec![];
    let mut cur = vec![];
    let mut depth = 0i32;
    let mut prev_dash = false;
    for t in toks {
        if is_punct(t, '<') { depth += 1; }
        if is_punct(t, '>') && !prev_dash { depth -= 1; }
        prev_dash = is_punct(t, '-');
        if is_punct(t, ',') && depth == 0 {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(t.clone());
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out
}

fn tokens_str(toks: &[TokenTree]) -> String {
    toks.iter().cloned().collect::<TokenStream>().to_string()
}

/// Leading attributes of a field: (has skip for this direction, rest).
fn strip_attrs(field: &[TokenTree], ser: bool) -> (bool, Vec<TokenTree>) {
    let mut i = 0;
    let mut skip = false;
    while i + 1 < field.len() && is_punct(&field[i], '#') {
        if let TokenTree::Group(g) = &field[i + 1] {
            let s = g.stream().to_string().replace(' ', "");
            if s.starts_with("serde(") {
                let inner = &s[6..s.len() - 1];
                for part in inner.split(',') {
                    let key = part.split('=').next().unwrap_or("");
                    if key == "skip" || (ser && key == "skip_serializing") || (!ser && key == "skip_deserializing") {
                        skip = true;
                    }
                }
            }
        }
        i += 2;
    }
    (skip, field[i..].to_vec())
}

/// Field types of a `{ a: T, ... }` group.
fn named_field_types(g: &proc_macro::Group, ser: bool) -> Vec<String> {
    let toks: Vec<TokenTree> = g.stream().into_iter().collect();
    let mut out = vec![];
    for f in split_commas(&toks) {
        let (skip, f) = strip_attrs(&f, ser);
        if skip { continue; }
        // skip `pub`, `pub(crate)`, then `name :`
        let mut i = 0;
        while i < f.len() {
            if is_punct(&f[i], ':') { break; }
            i += 1;
        }
        if i + 1 < f.len() { out.push(tokens_str(&f[i + 1..])); }
    }
    out
}

fn tuple_field_types(g: &proc_macro::Group, ser: bool) -> Vec<String> {
    let toks: Vec<TokenTree> = g.stream().into_iter().collect();
    let mut out = vec![];
    for f in split_commas(&toks) {
        let (skip, mut f) = strip_attrs(&f, ser);
        if skip { continue; }
        if matches!(f.first(), Some(TokenTree::Ident(i)) if i.to_string() == "pub") {
            f.remove(0);
            if matches!(f.first(), Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Parenthesis) { f.remove(0); }
        }
        if !f.is_empty() { out.push(tokens_str(&f)); }
    }
    out
}

fn derive(input: TokenStream, ser: bool) -> TokenStream {
    let toks: Vec<TokenTree> = input.into_iter().collect();
    let mut i = 0;
    let mut kind = String::new();
    while i < toks.len() {
        if let TokenTree::Ident(id) = &toks[i] {
            let s = id.to_string();
            if s == "struct" || s == "enum" { kind = s; break; }
        }
        i += 1;
    }
    let name = toks[i + 1].to_string();
    i += 2;
    // generics
    let mut generics = String::new();
    if i < toks.len() && is_punct(&toks[i], '<') {
        let mut depth = 0;
        let start = i;
        while i < toks.len() {
            if is_punct(&toks[i], '<') { depth += 1; }
            if is_punct(&toks[i], '>') { depth -= 1; if depth == 0 { i += 1; break; } }
            i += 1;
        }
        generics = tokens_str(&toks[start + 1..i - 1]);
    }
    let mut types = vec![];
    while i < toks.len() {
        if let TokenTree::Group(g) = &toks[i] {
            if kind == "struct" {
                match g.delimiter() {
                    Delimiter::Brace => types.extend(named_field_types(g, ser)),
                    Delimiter::Parenthesis => types.extend(tuple_field_types(g, ser)),
                    _ => {}
                }
            } else if g.delimiter() == Delimiter::Brace {
                // enum variants
                let vt: Vec<TokenTree> = g.stream().into_iter().collect();
                for v in split_commas(&vt) {
                    let (skip, v) = strip_attrs(&v, ser);
                    if skip { continue; }
                    for t in &v {
                        if let TokenTree::Group(fg) = t {
                            match fg.delimiter() {
                                Delimiter::Brace => types.extend(named_field_types(fg, ser)),
                                Delimiter::Parenthesis => types.extend(tuple_field_types(fg, ser)),
                                _ => {}
                            }
                        }
                    }
                }
            }
            break;
        }
        i += 1;
    }
    let params = generics.clone();
    let args: String = generics
        .split(',')
        .map(|p| p.split(':').next().unwrap_or("").trim().to_string())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(",");
    let (gp, ga) = if params.is_empty() { (String::new(), String::new()) } else { (format!("<{params}>"), format!("<{args}>")) };
    let checks: String = types
        .iter()
        .map(|t| if ser { format!("__a::<{t}>();") } else { format!("__a::<{t}>();") })
        .collect();
    let out = if ser {
        format!(
            "impl{gp} ::serde::Serialize for {name}{ga} {{}}
             const _: () = {{ #[allow(dead_code)] fn __a<T: ?Sized + ::serde::Serialize>() {{}} #[allow(dead_code)] fn __c{gp}() {{ {checks} }} }};"
        )
    } else {
        let dgp = if params.is_empty() { "<'de>".to_string() } else { format!("<'de, {params}>") };
        format!(
            "impl{dgp} ::serde::Deserialize<'de> for {name}{ga} {{}}
             const _: () = {{ #[allow(dead_code)] fn __a<T: ::serde::de::DeserializeOwned>() {{}} #[allow(dead_code)] fn __c{gp}() {{ {checks} }} }};"
        )
    };
    out.parse().expect("serde_derive stub: bad output")
}

#[proc_macro_derive(Serialize, attributes(serde))]
pub fn serialize(input: TokenStream) -> TokenStream {
    derive(input, true)
}

#[proc_macro_derive(Deserialize, attributes(serde))]
pub fn deserialize(input: TokenStream) -> TokenStream {
    derive(input, false)
}
