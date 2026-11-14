//! Plan W2.19: two processes on this machine find each other over real
//! multicast DNS and swap the pairing codes through the rendezvous, with no
//! server and no internet. The host runs as a child process
//! (`lan-mdns-demo host`); the joining side is this test process, and then a
//! second child (`lan-mdns-demo join`), so both directions of the swap run
//! across a process boundary.
//!
//! The container this was written in has one interface, on 192.0.2.0/24
//! (RFC 5737), so the processes run with `--test-net`, which adds that range
//! to the local-network rule. On a real LAN the strict rule applies; the unit
//! tests cover it.
use std::io::{BufRead, BufReader};
use std::net::IpAddr;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use lumen_lan_mdns as m;

const DEMO: &str = env!("CARGO_BIN_EXE_lan-mdns-demo");

fn test_net(ip: IpAddr) -> bool {
    m::net::is_lan_ip(ip) || matches!(ip, IpAddr::V4(v4) if v4.octets()[..3] == [192, 0, 2])
}

fn spawn_host(offer: &str) -> (Child, BufReader<std::process::ChildStdout>, String, u16) {
    let mut child = Command::new(DEMO).args(["host", offer, "--test-net"]).stdout(Stdio::piped()).spawn().expect("host process");
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    let p: Vec<&str> = line.split_whitespace().collect();
    assert_eq!(p[0], "READY", "{line}");
    (child, out, p[1].to_string(), p[2].parse().unwrap())
}

fn next(out: &mut BufReader<std::process::ChildStdout>) -> String {
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    line.trim_end().to_string()
}

#[test]
fn a_joining_process_finds_the_host_process_and_they_swap_codes() {
    let offer = "lumen-lan:1:zHostOffer_-1";
    let answer = "lumen-lan:1:zJoinAnswer_-2";
    let (mut host, mut out, label, port) = spawn_host(offer);

    // Browse until the host shows up (multicast on this machine; a few tries on a loaded one).
    let mut found = None;
    for _ in 0..5 {
        found = m::browse_with(Duration::from_millis(1500), test_net).unwrap().into_iter().find(|f| f.name == label);
        if found.is_some() {
            break;
        }
    }
    let f = found.expect("the host process was found over mDNS");
    assert_eq!(f.port, port);
    assert_eq!(f.txt, vec!["v=1".to_string()]);

    let (token, got) = m::fetch_offer_with(f.host, f.port, test_net).unwrap();
    assert_eq!(got, offer);
    m::send_answer_with(f.host, f.port, &token, answer, test_net).unwrap();
    assert_eq!(next(&mut out), format!("ANSWER {answer}"));
    assert!(host.wait().unwrap().success());
}

#[test]
fn two_child_processes_host_and_join() {
    let offer = "lumen-lan:1:zSecondOffer";
    let answer = "lumen-lan:1:zSecondAnswer";
    let (mut host, mut out, label, _port) = spawn_host(offer);
    let mut joined = None;
    for _ in 0..5 {
        let j = Command::new(DEMO).args(["join", answer, "--want", &label, "--test-net"]).output().unwrap();
        if j.status.success() {
            joined = Some(String::from_utf8_lossy(&j.stdout).into_owned());
            break;
        }
    }
    let j = joined.expect("the joining process found the host");
    assert!(j.contains(&format!("FOUND {label} ")), "{j}");
    assert!(j.contains(&format!("OFFER {offer}")), "{j}");
    assert!(j.contains("SENT"), "{j}");
    assert_eq!(next(&mut out), format!("ANSWER {answer}"));
    assert!(host.wait().unwrap().success());
}

#[test]
fn without_the_test_range_nothing_off_the_strict_local_network_is_answered() {
    // The host process answers only private, link-local and loopback senders; this
    // machine's only multicast source is 192.0.2.x, so a strict browse finds nothing from it.
    let mut host = Command::new(DEMO).args(["host", "lumen-lan:1:zStrict"]).stdout(Stdio::piped()).spawn().unwrap();
    let mut out = BufReader::new(host.stdout.take().unwrap());
    let label = next(&mut out).split_whitespace().nth(1).unwrap().to_string();
    let found = m::browse(Duration::from_millis(1500)).unwrap();
    assert!(found.iter().all(|f| f.name != label), "{found:?}");
    let _ = host.kill();
}
