//! Finding the other device on the local network (plan W2.19), with no
//! server and no internet: a device that keeps the vault announces
//! `_lumen-lan._tcp.local` over multicast DNS (RFC 6762, DNS-SD RFC 6763),
//! and serves its LAN link's pairing code on a small TCP "rendezvous" port.
//! A joining device browses, fetches the code, and sends its answer code
//! back the same way. That replaces scanning a QR code twice; the WebRTC
//! link, its local-addresses-only rule and the passphrase proof are
//! unchanged (src/sync/e2ee/lan/).
//!
//! What goes on the network in the clear: the service name, a random
//! instance name ("Lumen-K7Q2", shown on the hosting device so the user can
//! pick the right one), the rendezvous port, and the pairing codes. The codes
//! hold SDP only (the DTLS fingerprint and LAN candidates), never a key, the
//! same as the QR code anyone in the room could read. A device that takes the
//! code without the passphrase fails the vault's mutual proof.
//!
//! Only local-network peers are answered or contacted: private IPv4
//! (10/8, 172.16/12, 192.168/16), link-local 169.254/16 and loopback, the
//! same rule as src/sync/e2ee/lan/address.ts.

pub mod dns;
pub mod net;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use dns::{Message, Question, RData, Record};

pub const SERVICE: &str = "_lumen-lan._tcp.local";
pub const MDNS_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
pub const MDNS_PORT: u16 = 5353;
/// The rendezvous protocol's first word on every line.
pub const PROTOCOL: &str = "LUMEN-LAN/1";
/// A pairing code is `lumen-lan:1:` + mode + base64url (src/sync/e2ee/lan/link.ts).
pub const CODE_PREFIX: &str = "lumen-lan:1:";
pub const MAX_LINE: usize = 64 * 1024;
const TTL: u32 = 120;
/// How long a pairing stays offered (review 28, L3): the port closes and the announcement stops after this,
/// even if the app's page never says so (reloaded or crashed mid-pairing).
pub const OFFER_TTL: Duration = Duration::from_secs(5 * 60);
/// Connections the rendezvous serves at once; more are closed straight away (review 28, L3).
pub const MAX_CONNECTIONS: usize = 8;

/// Which addresses may be answered or contacted. The app uses `net::is_lan_ip`;
/// only the two-process test widens it (its container has no private address).
pub type Allow = fn(IpAddr) -> bool;

/// A device found on the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// The instance label, e.g. "Lumen-K7Q2".
    pub name: String,
    /// The address the answer came from (what the joining device can reach).
    pub host: IpAddr,
    pub port: u16,
    pub txt: Vec<String>,
}

/// Is this a pairing code (prefix, one mode letter, base64url only, bounded)?
pub fn is_code(s: &str) -> bool {
    s.len() > CODE_PREFIX.len() + 1
        && s.len() <= MAX_LINE - 200
        && s.starts_with(CODE_PREFIX)
        && s[CODE_PREFIX.len()..].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// A random instance label: "Lumen-" and four letters or digits a person can read out.
pub fn instance_label() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ23456789";
    let r = net::random_u64();
    let s: String = (0..4).map(|i| ALPHABET[((r >> (i * 8)) as usize) % ALPHABET.len()] as char).collect();
    format!("Lumen-{s}")
}

fn instance_fqdn(label: &str) -> String {
    format!("{label}.{SERVICE}")
}

/* ─── Announcing ─────────────────────────────────────────────────────── */

/// The answer a hosting device gives: PTR → instance, SRV → port, TXT.
pub fn response(label: &str, port: u16, txt: &[String], id: u16) -> Vec<u8> {
    let inst = instance_fqdn(label);
    let target = format!("{label}.local");
    let m = Message {
        id,
        response: true,
        questions: vec![],
        records: vec![
            Record { name: SERVICE.into(), ttl: TTL, data: RData::Ptr(inst.clone()) },
            Record { name: inst.clone(), ttl: TTL, data: RData::Srv { priority: 0, weight: 0, port, target } },
            Record { name: inst, ttl: TTL, data: RData::Txt(txt.to_vec()) },
        ],
    };
    dns::encode(&m).unwrap_or_default()
}

/// Does a query ask for this service or this instance?
pub fn asks_for(m: &Message, label: &str) -> bool {
    if m.response {
        return false;
    }
    let inst = instance_fqdn(label);
    m.questions.iter().any(|q| {
        (dns::same_name(&q.name, SERVICE) && (q.qtype == dns::TYPE_PTR || q.qtype == dns::TYPE_ANY))
            || (dns::same_name(&q.name, &inst) && matches!(q.qtype, dns::TYPE_SRV | dns::TYPE_TXT | dns::TYPE_ANY))
    })
}

/// Answers queries for the service while it lives; stops when dropped.
pub struct Advertiser {
    pub label: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Advertiser {
    /// Listen on the mDNS port (shared with the OS's own responder where it
    /// allows) and answer for `label`, port `port`. Announces twice at once.
    pub fn start(label: String, port: u16, txt: Vec<String>) -> std::io::Result<Advertiser> {
        Self::start_with(label, port, txt, net::is_lan_ip)
    }

    pub fn start_with(label: String, port: u16, txt: Vec<String>, allow: Allow) -> std::io::Result<Advertiser> {
        Self::start_for(label, port, txt, allow, OFFER_TTL)
    }

    /// As `start_with`, answering for `ttl` at most.
    pub fn start_for(label: String, port: u16, txt: Vec<String>, allow: Allow, ttl: Duration) -> std::io::Result<Advertiser> {
        let sock = net::bind_mdns()?;
        sock.join_multicast_v4(&MDNS_GROUP, &Ipv4Addr::UNSPECIFIED)?;
        sock.set_multicast_ttl_v4(255)?;
        sock.set_read_timeout(Some(Duration::from_millis(200)))?;
        let group = SocketAddr::V4(SocketAddrV4::new(MDNS_GROUP, MDNS_PORT));
        let announce = response(&label, port, &txt, 0);
        for _ in 0..2 {
            let _ = sock.send_to(&announce, group);
        }
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let l = label.clone();
        let born = Instant::now();
        let thread = std::thread::spawn(move || {
            let mut buf = [0u8; dns::MAX_MESSAGE];
            while !flag.load(Ordering::Relaxed) && born.elapsed() < ttl {
                let (n, from) = match sock.recv_from(&mut buf) {
                    Ok(x) => x,
                    Err(_) => continue,
                };
                if !allow(from.ip()) {
                    continue;
                }
                let Ok(q) = dns::decode(&buf[..n]) else { continue };
                if !asks_for(&q, &l) {
                    continue;
                }
                // A one-shot query from another port gets a unicast answer with its id (RFC 6762 §6.7);
                // one that asks for unicast gets it too; the rest are answered on the group.
                let unicast = from.port() != MDNS_PORT || q.questions.iter().any(|x| x.unicast);
                let reply = response(&l, port, &txt, if from.port() != MDNS_PORT { q.id } else { 0 });
                let _ = sock.send_to(&reply, if unicast { from } else { group });
            }
        });
        Ok(Advertiser { label, stop, thread: Some(thread) })
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Advertiser {
    fn drop(&mut self) {
        self.stop();
    }
}

/* ─── Browsing ───────────────────────────────────────────────────────── */

/// A one-shot query for the service (RFC 6762 §5.1), asking for unicast answers.
pub fn query(id: u16) -> Vec<u8> {
    let m = Message { id, response: false, questions: vec![Question { name: SERVICE.into(), qtype: dns::TYPE_PTR, unicast: true }], records: vec![] };
    dns::encode(&m).unwrap_or_default()
}

/// The devices one response names (PTR → SRV, TXT for the same instance), placed at `from`.
pub fn found_in(m: &Message, from: IpAddr) -> Vec<Found> {
    let mut out = Vec::new();
    if !m.response {
        return out;
    }
    for r in &m.records {
        let RData::Ptr(inst) = &r.data else { continue };
        if !dns::same_name(&r.name, SERVICE) {
            continue;
        }
        let Some(label) = inst.strip_suffix(&format!(".{SERVICE}")) else { continue };
        if label.is_empty() || label.len() > 63 || label.contains('.') {
            continue;
        }
        let port = m.records.iter().find_map(|x| match &x.data {
            RData::Srv { port, .. } if dns::same_name(&x.name, inst) && *port != 0 => Some(*port),
            _ => None,
        });
        let txt = m.records.iter().find_map(|x| match &x.data {
            RData::Txt(t) if dns::same_name(&x.name, inst) => Some(t.clone()),
            _ => None,
        });
        if let Some(port) = port {
            out.push(Found { name: label.to_string(), host: from, port, txt: txt.unwrap_or_default() });
        }
    }
    out
}

/// Ask for the service for `wait`, resending the query a few times; local-network answers only.
pub fn browse(wait: Duration) -> std::io::Result<Vec<Found>> {
    browse_with(wait, net::is_lan_ip)
}

pub fn browse_with(wait: Duration, allow: Allow) -> std::io::Result<Vec<Found>> {
    let sock = UdpSocket::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)))?;
    sock.set_multicast_ttl_v4(255)?;
    sock.set_multicast_loop_v4(true)?;
    sock.set_read_timeout(Some(Duration::from_millis(100)))?;
    let group = SocketAddr::V4(SocketAddrV4::new(MDNS_GROUP, MDNS_PORT));
    let id = (net::random_u64() & 0xffff) as u16;
    let q = query(id);
    let start = Instant::now();
    let resend = [Duration::ZERO, Duration::from_millis(250), Duration::from_millis(1000)];
    let mut sent = 0;
    // Every device that answers, even two with the same name (review 28, L2): the app warns about those.
    let mut seen: HashMap<(String, IpAddr, u16), Found> = HashMap::new();
    let mut buf = [0u8; dns::MAX_MESSAGE];
    while start.elapsed() < wait {
        if sent < resend.len() && start.elapsed() >= resend[sent] {
            let _ = sock.send_to(&q, group);
            sent += 1;
        }
        let Ok((n, from)) = sock.recv_from(&mut buf) else { continue };
        if !allow(from.ip()) {
            continue;
        }
        let Ok(m) = dns::decode(&buf[..n]) else { continue };
        for f in found_in(&m, from.ip()) {
            seen.insert((f.name.clone(), f.host, f.port), f);
        }
    }
    let mut v: Vec<Found> = seen.into_values().collect();
    v.sort_by(|a, b| (&a.name, a.host, a.port).cmp(&(&b.name, b.host, b.port)));
    Ok(v)
}

/* ─── The rendezvous: swap the pairing codes ─────────────────────────── */

/// What the rendezvous holds: the host's offer code, the token for it, and the answer once one came.
#[derive(Default)]
struct Slot {
    offer: Option<String>,
    token: String,
    answer: Option<String>,
    /// An answer came: the offer is used up, even once the answer was taken.
    used: bool,
    /// The offer's time ran out (OFFER_TTL).
    expired: bool,
}

/// One pairing at a time: `OFFER` hands out the code once an answer hasn't come yet; the first good `ANSWER` uses it up.
///
///   → LUMEN-LAN/1 OFFER                   ← OK <token> <offer code>     | ERR used
///   → LUMEN-LAN/1 ANSWER <token> <code>   ← OK                          | ERR token | ERR used | ERR bad
pub struct Rendezvous {
    pub port: u16,
    slot: Arc<Mutex<Slot>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

fn handle_line(slot: &Mutex<Slot>, line: &str) -> String {
    let mut parts = line.trim_end_matches(['\r', '\n']).split(' ');
    if parts.next() != Some(PROTOCOL) {
        return "ERR bad".into();
    }
    let Ok(mut s) = slot.lock() else { return "ERR bad".into() };
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("OFFER"), None, _, _) => match (&s.offer, s.used) {
            (Some(o), false) => format!("OK {} {}", s.token, o),
            _ => "ERR used".into(),
        },
        (Some("ANSWER"), Some(token), Some(code), None) => {
            if s.used || s.offer.is_none() {
                "ERR used".into()
            } else if !net::same_secret(token.as_bytes(), s.token.as_bytes()) {
                "ERR token".into()
            } else if !is_code(code) {
                "ERR bad".into()
            } else {
                s.answer = Some(code.to_string());
                s.used = true;
                "OK".into()
            }
        }
        _ => "ERR bad".into(),
    }
}

/// Read one line of at most MAX_LINE bytes.
fn read_line(stream: &TcpStream) -> std::io::Result<String> {
    let mut line = String::new();
    BufReader::new(stream.take(MAX_LINE as u64)).read_line(&mut line)?;
    Ok(line)
}

impl Rendezvous {
    /// Serve `offer` on an ephemeral TCP port, to local-network clients only.
    pub fn start(offer: String) -> std::io::Result<Rendezvous> {
        Self::start_with(offer, net::is_lan_ip)
    }

    pub fn start_with(offer: String, allow: Allow) -> std::io::Result<Rendezvous> {
        Self::start_for(offer, allow, OFFER_TTL, MAX_CONNECTIONS)
    }

    /// As `start_with`, offered for `ttl` at most, serving `max_conns` connections at once.
    pub fn start_for(offer: String, allow: Allow, ttl: Duration, max_conns: usize) -> std::io::Result<Rendezvous> {
        if !is_code(&offer) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a pairing code"));
        }
        let listener = TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let slot = Arc::new(Mutex::new(Slot { offer: Some(offer), token: net::token(), answer: None, used: false, expired: false }));
        let stop = Arc::new(AtomicBool::new(false));
        let (s2, f2) = (slot.clone(), stop.clone());
        let active = Arc::new(AtomicUsize::new(0));
        let born = Instant::now();
        let thread = std::thread::spawn(move || {
            while !f2.load(Ordering::Relaxed) {
                if born.elapsed() >= ttl {
                    // Expired: nothing more is handed out, and the listener closes with this thread.
                    if let Ok(mut s) = s2.lock() {
                        s.offer = None;
                        s.expired = true;
                    }
                    break;
                }
                match listener.accept() {
                    Ok((stream, from)) => {
                        if !allow(from.ip()) {
                            continue;
                        }
                        if active.load(Ordering::SeqCst) >= max_conns {
                            drop(stream);
                            continue;
                        }
                        active.fetch_add(1, Ordering::SeqCst);
                        let s3 = s2.clone();
                        let a3 = active.clone();
                        std::thread::spawn(move || {
                            struct Done(Arc<AtomicUsize>);
                            impl Drop for Done {
                                fn drop(&mut self) {
                                    self.0.fetch_sub(1, Ordering::SeqCst);
                                }
                            }
                            let _done = Done(a3);
                            let _ = stream.set_nonblocking(false);
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                            if let Ok(line) = read_line(&stream) {
                                let reply = handle_line(&s3, &line);
                                let _ = (&stream).write_all(format!("{reply}\n").as_bytes());
                            }
                        });
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        });
        Ok(Rendezvous { port, slot, stop, thread: Some(thread) })
    }

    /// The answer code, once a joining device sent one (taken once).
    pub fn take_answer(&self) -> Option<String> {
        self.slot.lock().ok()?.answer.take()
    }

    /// Whether the offer ran out of time without being used.
    pub fn expired(&self) -> bool {
        self.slot.lock().map(|s| s.expired).unwrap_or(false)
    }

    /// Whether an answer came (it may already have been taken).
    pub fn answered(&self) -> bool {
        self.slot.lock().map(|s| s.used).unwrap_or(false)
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Rendezvous {
    fn drop(&mut self) {
        self.stop();
    }
}

fn ask(host: IpAddr, port: u16, line: &str, allow: Allow) -> std::io::Result<String> {
    if !allow(host) {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "not a local-network address"));
    }
    let stream = TcpStream::connect_timeout(&SocketAddr::new(host, port), Duration::from_secs(3))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    (&stream).write_all(format!("{line}\n").as_bytes())?;
    Ok(read_line(&stream)?.trim_end().to_string())
}

fn refused(reply: &str) -> std::io::Error {
    std::io::Error::other(reply.strip_prefix("ERR ").unwrap_or("bad").to_string())
}

/// The host's offer code and its token.
pub fn fetch_offer(host: IpAddr, port: u16) -> std::io::Result<(String, String)> {
    fetch_offer_with(host, port, net::is_lan_ip)
}

pub fn fetch_offer_with(host: IpAddr, port: u16, allow: Allow) -> std::io::Result<(String, String)> {
    let reply = ask(host, port, &format!("{PROTOCOL} OFFER"), allow)?;
    let mut p = reply.splitn(3, ' ');
    match (p.next(), p.next(), p.next()) {
        (Some("OK"), Some(token), Some(offer)) if is_code(offer) && !token.is_empty() => Ok((token.to_string(), offer.to_string())),
        _ => Err(refused(&reply)),
    }
}

/// Send this device's answer code for the offer `token` named.
pub fn send_answer(host: IpAddr, port: u16, token: &str, answer: &str) -> std::io::Result<()> {
    send_answer_with(host, port, token, answer, net::is_lan_ip)
}

pub fn send_answer_with(host: IpAddr, port: u16, token: &str, answer: &str, allow: Allow) -> std::io::Result<()> {
    if !is_code(answer) || token.contains(' ') {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a pairing code"));
    }
    let reply = ask(host, port, &format!("{PROTOCOL} ANSWER {token} {answer}"), allow)?;
    if reply == "OK" {
        Ok(())
    } else {
        Err(refused(&reply))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

    const OFFER: &str = "lumen-lan:1:zAbC-_123";
    const ANSWER: &str = "lumen-lan:1:zXyZ987_-";

    #[test]
    fn a_query_and_an_answer_round_trip_and_name_the_device() {
        let q = dns::decode(&query(7)).unwrap();
        assert_eq!(q.questions, vec![Question { name: SERVICE.into(), qtype: dns::TYPE_PTR, unicast: true }]);
        assert!(asks_for(&q, "Lumen-K7Q2"));
        let r = dns::decode(&response("Lumen-K7Q2", 40123, &["v=1".into()], 7)).unwrap();
        assert!(r.response);
        assert!(!asks_for(&r, "Lumen-K7Q2"), "an answer is never taken for a question");
        let from: IpAddr = "192.168.1.20".parse().unwrap();
        assert_eq!(found_in(&r, from), vec![Found { name: "Lumen-K7Q2".into(), host: from, port: 40123, txt: vec!["v=1".into()] }]);
    }

    #[test]
    fn other_services_and_other_instances_are_not_answered() {
        let other = Message { id: 1, response: false, questions: vec![Question { name: "_airplay._tcp.local".into(), qtype: dns::TYPE_PTR, unicast: false }], records: vec![] };
        assert!(!asks_for(&other, "Lumen-K7Q2"));
        let srv = Message { id: 1, response: false, questions: vec![Question { name: "Lumen-AAAA._lumen-lan._tcp.local".into(), qtype: dns::TYPE_SRV, unicast: false }], records: vec![] };
        assert!(!asks_for(&srv, "Lumen-K7Q2"));
        assert!(asks_for(&srv, "Lumen-AAAA"));
        // Case and a trailing dot don't matter (RFC 6762 §16).
        let upper = Message { id: 1, response: false, questions: vec![Question { name: "_LUMEN-LAN._tcp.local.".into(), qtype: dns::TYPE_ANY, unicast: false }], records: vec![] };
        assert!(asks_for(&upper, "Lumen-K7Q2"));
    }

    #[test]
    fn hostile_packets_are_refused_not_followed() {
        // A compression pointer to itself (a loop) and one forward.
        let mut looped = vec![0, 1, 0x84, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        looped.extend_from_slice(&[0xc0, 12, 0, 12, 0, 1]);
        assert!(dns::decode(&looped).is_err());
        let mut fwd = vec![0, 1, 0x84, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        fwd.extend_from_slice(&[0xc0, 40, 0, 12, 0, 1]);
        assert!(dns::decode(&fwd).is_err());
        // Truncated, and more records than bytes.
        assert!(dns::decode(&[0, 1, 0x84]).is_err());
        assert!(dns::decode(&[0, 1, 0x84, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0]).is_err());
        // Every prefix of a good answer either parses or is refused; none panics.
        let good = response("Lumen-K7Q2", 1, &["v=1".into()], 0);
        for n in 0..good.len() {
            let _ = dns::decode(&good[..n]);
        }
        // An instance label with a dot, or an SRV with port 0, finds nothing.
        let bad = Message {
            id: 0,
            response: true,
            questions: vec![],
            records: vec![
                Record { name: SERVICE.into(), ttl: 1, data: RData::Ptr(format!("a.b.{SERVICE}")) },
                Record { name: SERVICE.into(), ttl: 1, data: RData::Ptr(format!("Lumen-ZZZZ.{SERVICE}")) },
                Record { name: format!("Lumen-ZZZZ.{SERVICE}"), ttl: 1, data: RData::Srv { priority: 0, weight: 0, port: 0, target: "x.local".into() } },
            ],
        };
        assert!(found_in(&dns::decode(&dns::encode(&bad).unwrap()).unwrap(), "10.0.0.2".parse().unwrap()).is_empty());
    }

    #[test]
    fn the_local_network_rule_matches_address_ts() {
        for ok in ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.3.4", "127.0.0.1", "::1", "fe80::1", "fd12::1", "::ffff:192.168.1.2"] {
            assert!(net::is_lan_ip(ok.parse().unwrap()), "{ok}");
        }
        for no in ["8.8.8.8", "172.32.0.1", "192.0.2.2", "100.64.0.1", "2001:db8::1", "::ffff:8.8.8.8"] {
            assert!(!net::is_lan_ip(no.parse().unwrap()), "{no}");
        }
        assert!(!net::is_lan_ip(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
    }

    #[test]
    fn the_rendezvous_hands_the_offer_out_once_and_takes_one_answer_for_its_token() {
        let slot = Mutex::new(Slot { offer: Some(OFFER.into()), token: "t0k3n".into(), answer: None, used: false, expired: false });
        assert_eq!(handle_line(&slot, "LUMEN-LAN/1 OFFER\n"), format!("OK t0k3n {OFFER}"));
        assert_eq!(handle_line(&slot, &format!("LUMEN-LAN/1 ANSWER wrong {ANSWER}")), "ERR token");
        assert_eq!(handle_line(&slot, "LUMEN-LAN/1 ANSWER t0k3n not-a-code"), "ERR bad");
        assert_eq!(handle_line(&slot, &format!("LUMEN-LAN/2 ANSWER t0k3n {ANSWER}")), "ERR bad");
        assert_eq!(handle_line(&slot, &format!("LUMEN-LAN/1 ANSWER t0k3n {ANSWER} extra")), "ERR bad");
        assert_eq!(handle_line(&slot, &format!("LUMEN-LAN/1 ANSWER t0k3n {ANSWER}\r\n")), "OK");
        // Used up: no second answer, and the offer is no longer handed out, even after the answer was taken.
        assert_eq!(slot.lock().unwrap().answer.take().as_deref(), Some(ANSWER));
        assert_eq!(handle_line(&slot, &format!("LUMEN-LAN/1 ANSWER t0k3n {ANSWER}")), "ERR used");
        assert_eq!(handle_line(&slot, "LUMEN-LAN/1 OFFER"), "ERR used");
    }

    #[test]
    fn codes_and_tokens() {
        assert!(is_code(OFFER));
        assert!(!is_code("lumen-lan:1:"));
        assert!(!is_code("lumen-lan:1:z abc"));
        assert!(!is_code("lumen-lan:2:zabc"));
        assert!(!is_code(&format!("lumen-lan:1:z{}", "a".repeat(MAX_LINE))));
        let (a, b) = (net::token(), net::token());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert!(net::same_secret(b"abc", b"abc") && !net::same_secret(b"abc", b"abd") && !net::same_secret(b"abc", b"ab"));
        let l = instance_label();
        assert!(l.starts_with("Lumen-") && l.len() == 10, "{l}");
    }

    #[test]
    fn a_client_never_contacts_an_address_off_the_local_network() {
        let e = fetch_offer("8.8.8.8".parse().unwrap(), 9).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::PermissionDenied);
        let e = send_answer("1.1.1.1".parse().unwrap(), 9, "t", ANSWER).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn an_offer_expires_and_its_port_closes() {
        let r = Rendezvous::start_for(OFFER.into(), net::is_lan_ip, Duration::from_millis(300), MAX_CONNECTIONS).unwrap();
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        assert!(fetch_offer(lo, r.port).is_ok());
        let t0 = Instant::now();
        while !r.expired() && t0.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(r.expired());
        // The listener is gone with the thread: nothing answers on the port any more.
        std::thread::sleep(Duration::from_millis(100));
        assert!(fetch_offer(lo, r.port).is_err());
        assert_eq!(OFFER_TTL, Duration::from_secs(300));
    }

    #[test]
    fn connections_over_the_cap_are_closed_and_the_rest_still_served() {
        let r = Rendezvous::start_for(OFFER.into(), net::is_lan_ip, OFFER_TTL, 2).unwrap();
        let lo = SocketAddr::new("127.0.0.1".parse().unwrap(), r.port);
        // Two idle connections hold both places (each times out after 5 s).
        let idle: Vec<TcpStream> = (0..2).map(|_| TcpStream::connect(lo).unwrap()).collect();
        std::thread::sleep(Duration::from_millis(300));
        let extra = fetch_offer(lo.ip(), r.port);
        assert!(extra.is_err(), "a third connection is closed while two are open");
        drop(idle);
        // Places come back when the idle ones end.
        let t0 = Instant::now();
        let mut ok = false;
        while t0.elapsed() < Duration::from_secs(15) {
            if fetch_offer(lo.ip(), r.port).is_ok() {
                ok = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(ok);
    }

    #[test]
    fn the_rendezvous_over_tcp_on_loopback() {
        let r = Rendezvous::start(OFFER.into()).unwrap();
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        let (token, offer) = fetch_offer(lo, r.port).unwrap();
        assert_eq!(offer, OFFER);
        assert_eq!(send_answer(lo, r.port, "nope", ANSWER).unwrap_err().to_string(), "token");
        send_answer(lo, r.port, &token, ANSWER).unwrap();
        assert_eq!(send_answer(lo, r.port, &token, ANSWER).unwrap_err().to_string(), "used");
        assert_eq!(r.take_answer().as_deref(), Some(ANSWER));
        assert!(r.answered());
        assert!(Rendezvous::start("not a code".into()).is_err());
    }
}
