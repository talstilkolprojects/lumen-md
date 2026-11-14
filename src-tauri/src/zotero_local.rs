//! Zotero's local API (plan W2.15), asked natively. Zotero 7 serves the
//! user's library read-only at http://127.0.0.1:23119/api/ to apps on the
//! same computer, and refuses requests from browsers (a Mozilla
//! User-Agent or an Origin header), so the web view can't ask it itself.
//! This is a tiny HTTP/1.0 GET over std's TcpStream, only to 127.0.0.1 and
//! only under /api/: nothing else is reachable through it.
//!
//! std only, so `rustc --test` checks it without the Tauri crates.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub const ZOTERO_PORT: u16 = 23119;
const MAX_BODY: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalResponse {
    pub status: u16,
    pub total: Option<u64>,
    pub body: String,
}

/// A path the bridge may request: `/api/…`, printable ASCII, no spaces, no `..`.
pub fn valid_path(path: &str) -> bool {
    path.starts_with("/api/")
        && path.len() < 4096
        && path.bytes().all(|b| (0x21..0x7f).contains(&b))
        && !path.contains("..")
        && !path.contains('#')
}

/// Parse an HTTP/1.x response: status, the Total-Results header, the body (Content-Length when sent).
pub fn parse_response(raw: &[u8]) -> Result<LocalResponse, String> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("no end of headers in Zotero's answer")?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| "headers are not UTF-8")?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.split_whitespace();
    let proto = parts.next().unwrap_or("");
    if !proto.starts_with("HTTP/1.") {
        return Err(format!("not an HTTP answer: {status_line}"));
    }
    let status: u16 = parts
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("bad status line: {status_line}"))?;
    let mut total = None;
    let mut length = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            match k.trim().to_ascii_lowercase().as_str() {
                "total-results" => total = v.parse().ok(),
                "content-length" => length = v.parse::<usize>().ok(),
                _ => {}
            }
        }
    }
    let mut body = &raw[split + 4..];
    if let Some(n) = length {
        if body.len() < n {
            return Err(format!("Zotero's answer was cut short ({} of {n} bytes)", body.len()));
        }
        body = &body[..n];
    }
    Ok(LocalResponse { status, total, body: String::from_utf8_lossy(body).into_owned() })
}

/// GET `path` from 127.0.0.1:`port`.
pub fn get(port: u16, path: &str) -> Result<LocalResponse, String> {
    if !valid_path(path) {
        return Err(format!("refused path {path:?}"));
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("connect to Zotero on 127.0.0.1:{port}: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(30))).map_err(|e| e.to_string())?;
    s.set_write_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    // Not a browser: no Origin header and a User-Agent that isn't "Mozilla/…".
    let req = format!(
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: Lumen-desktop\r\nZotero-API-Version: 3\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    s.take(MAX_BODY as u64 + 64 * 1024).read_to_end(&mut raw).map_err(|e| e.to_string())?;
    parse_response(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    /// A one-request server on an ephemeral port that records the request and sends `answer`.
    fn serve(answer: &'static [u8]) -> (u16, thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = c.read(&mut buf).unwrap();
            c.write_all(answer).unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (port, h)
    }

    #[test]
    fn paths() {
        assert!(valid_path("/api/users/0/items?itemType=annotation&limit=100&start=0"));
        assert!(valid_path("/api/users/0/items?itemKey=AB12CD34,EF56GH78"));
        assert!(!valid_path("/connector/ping"));
        assert!(!valid_path("/api/../connector/saveItems"));
        assert!(!valid_path("/api/users/0/items HTTP/1.0\r\nX: y"));
        assert!(!valid_path("/api/ users"));
        assert!(!valid_path("/api/#x"));
    }

    #[test]
    fn parses_status_total_and_body() {
        let r = parse_response(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nTotal-Results: 57\r\nContent-Length: 2\r\n\r\n[]extra").unwrap();
        assert_eq!(r, LocalResponse { status: 200, total: Some(57), body: "[]".into() });
        let r = parse_response(b"HTTP/1.1 403 Forbidden\r\n\r\nLocal API is not enabled").unwrap();
        assert_eq!((r.status, r.total, r.body.as_str()), (403, None, "Local API is not enabled"));
        assert!(parse_response(b"HTTP/1.0 200 OK\r\nContent-Length: 10\r\n\r\nshort").is_err());
        assert!(parse_response(b"garbage").is_err());
        assert!(parse_response(b"SMTP 220 hi\r\n\r\n").is_err());
    }

    #[test]
    fn asks_like_an_app_not_a_browser() {
        let (port, h) = serve(b"HTTP/1.0 200 OK\r\nTotal-Results: 1\r\n\r\n[{\"key\":\"ABCD1234\"}]");
        let r = get(port, "/api/users/0/items?itemType=annotation&limit=100&start=0").unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.total, Some(1));
        assert_eq!(r.body, "[{\"key\":\"ABCD1234\"}]");
        let req = h.join().unwrap();
        assert!(req.starts_with("GET /api/users/0/items?itemType=annotation&limit=100&start=0 HTTP/1.0\r\n"));
        assert!(req.contains("User-Agent: Lumen-desktop\r\n"));
        assert!(!req.to_ascii_lowercase().contains("origin:"));
        assert!(!req.contains("Mozilla"));
    }

    #[test]
    fn refuses_bad_paths_and_reports_no_server() {
        assert!(get(ZOTERO_PORT, "/connector/saveItems").unwrap_err().starts_with("refused path"));
        // A port nothing listens on (bound, then freed).
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(get(port, "/api/users/0/items").unwrap_err().contains("connect to Zotero"));
    }
}
