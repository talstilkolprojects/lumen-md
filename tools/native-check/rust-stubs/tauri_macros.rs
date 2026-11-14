//! Stub `tauri-macros` for offline type-checking (plan W4.23).
//! `#[command]` keeps the function and adds a check function that enforces
//! what the real macro enforces: every argument is a command argument
//! (Deserialize, State, AppHandle, Window, Request...), the return value is
//! an IPC response (Serialize / ipc::Response, or Result<that, E: Into<InvokeError>>),
//! an async command's future is Send, and an async command that borrows
//! (State<'_, T>, Request<'_>, &T) returns a Result.
extern crate proc_macro;
use proc_macro::{Delimiter, TokenStream, TokenTree};

fn is_punct(t: &TokenTree, c: char) -> bool {
    matches!(t, TokenTree::Punct(p) if p.as_char() == c)
}

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

fn s(toks: &[TokenTree]) -> String {
    toks.iter().cloned().collect::<TokenStream>().to_string()
}

#[proc_macro_attribute]
pub fn command(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let toks: Vec<TokenTree> = item.clone().into_iter().collect();
    let mut i = 0;
    let mut is_async = false;
    while i < toks.len() {
        if let TokenTree::Ident(id) = &toks[i] {
            let w = id.to_string();
            if w == "async" { is_async = true; }
            if w == "fn" { break; }
        }
        i += 1;
    }
    let name = toks[i + 1].to_string();
    let args_group = match &toks[i + 2] {
        TokenTree::Group(g) if g.delimiter() == Delimiter::Parenthesis => g.clone(),
        _ => return r#"compile_error!("stub #[command]: generic commands are not supported");"#.parse().unwrap(),
    };
    // return type: tokens between `->` and the body
    let mut ret: Vec<TokenTree> = vec![];
    let mut j = i + 3;
    if j + 1 < toks.len() && is_punct(&toks[j], '-') && is_punct(&toks[j + 1], '>') {
        j += 2;
        while j < toks.len() {
            if let TokenTree::Group(g) = &toks[j] {
                if g.delimiter() == Delimiter::Brace { break; }
            }
            if let TokenTree::Ident(id) = &toks[j] {
                if id.to_string() == "where" { break; }
            }
            ret.push(toks[j].clone());
            j += 1;
        }
    }
    let arg_toks: Vec<TokenTree> = args_group.stream().into_iter().collect();
    let mut params = vec![];
    let mut names = vec![];
    let mut checks = String::new();
    let mut borrows = false;
    for a in split_commas(&arg_toks) {
        let mut k = 0;
        while k < a.len() && !is_punct(&a[k], ':') { k += 1; }
        let pat: Vec<TokenTree> = a[..k].iter().filter(|t| t.to_string() != "mut").cloned().collect();
        let ty = s(&a[k + 1..]);
        if ty.contains("'_") || ty.trim_start().starts_with('&') { borrows = true; }
        let n = s(&pat);
        params.push(format!("{n}: {ty}"));
        names.push(n);
        checks.push_str(&format!("__arg::<{ty}>();"));
    }
    let ret_s = s(&ret);
    let ret_trim = ret_s.replace(' ', "");
    let is_result = ret_trim.starts_with("Result<") || ret_trim.ends_with("::Result") || ret_trim.contains("::Result<") || ret_trim.starts_with("std::result::Result<");
    if ret.is_empty() {
        // `()` is fine
    } else if is_result {
        // split generic args of the outer Result<...>
        let mut k = 0;
        while k < ret.len() && !is_punct(&ret[k], '<') { k += 1; }
        let inner = &ret[k + 1..ret.len() - 1];
        let parts = split_commas(inner);
        checks.push_str(&format!("__ok::<{}>();", s(&parts[0])));
        if parts.len() > 1 { checks.push_str(&format!("__err::<{}>();", s(&parts[1]))); }
    } else {
        checks.push_str(&format!("__ok::<{ret_s}>();"));
    }
    if is_async && borrows && !is_result {
        return format!(r#"compile_error!("async commands that contain references as inputs must return a `Result` ({name})");"#).parse().unwrap();
    }
    let send = if is_async {
        format!(
            "#[allow(dead_code, unused_variables, non_snake_case, clippy::all)] fn __lumen_send_{name}({}) {{ fn __s<T: Send>(_: T) {{}} __s({name}({})); }}",
            params.join(", "),
            names.join(", ")
        )
    } else {
        String::new()
    };
    let check = format!(
        "#[allow(dead_code, non_snake_case)] fn __lumen_check_{name}() {{
            fn __arg<'de, T: ::tauri::ipc::CommandArg<'de, ::tauri::Wry>>() {{}}
            fn __ok<T: ::tauri::ipc::IpcResponse>() {{}}
            fn __err<T: ::core::convert::Into<::tauri::ipc::InvokeError>>() {{}}
            {checks}
        }}
        {send}"
    );
    let mut out = item;
    out.extend(check.parse::<TokenStream>().expect("tauri_macros stub: bad check"));
    out
}

#[proc_macro_attribute]
pub fn mobile_entry_point(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}
