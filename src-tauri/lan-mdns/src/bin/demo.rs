//! Two processes on one machine, for the W2.19 test (tests/two_process.rs) and by hand:
//!
//!   lan-mdns-demo host <offer code> [--test-net]    announce, serve the code, print the answer that comes
//!   lan-mdns-demo join <answer code> [--want <label>] [--test-net]
//!                                                   browse, fetch the host's code, send the answer
//!
//! `--test-net` also allows 192.0.2.0/24 (RFC 5737), for a container whose only
//! interface has such an address; the app itself never does.
use std::net::IpAddr;
use std::time::{Duration, Instant};

use lumen_lan_mdns::{self as m, net};

fn test_net(ip: IpAddr) -> bool {
    net::is_lan_ip(ip) || matches!(ip, IpAddr::V4(v4) if v4.octets()[..3] == [192, 0, 2])
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let allow: m::Allow = if args.iter().any(|a| a == "--test-net") { test_net } else { net::is_lan_ip };
    let flag = |n: &str| args.iter().position(|a| a == n).and_then(|i| args.get(i + 1)).cloned();
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("host"), Some(offer)) => {
            let r = m::Rendezvous::start_with(offer.clone(), allow).expect("rendezvous");
            let label = m::instance_label();
            let _a = m::Advertiser::start_with(label.clone(), r.port, vec!["v=1".into()], allow).expect("advertise");
            println!("READY {label} {}", r.port);
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(60) {
                if let Some(answer) = r.take_answer() {
                    println!("ANSWER {answer}");
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            eprintln!("no answer");
            std::process::exit(3);
        }
        (Some("join"), Some(answer)) => {
            let want = flag("--want");
            let found = m::browse_with(Duration::from_secs(3), allow).expect("browse");
            let Some(f) = found.into_iter().find(|f| want.as_deref().map_or(true, |w| w == f.name)) else {
                eprintln!("nothing found");
                std::process::exit(4);
            };
            println!("FOUND {} {} {}", f.name, f.host, f.port);
            let (token, offer) = m::fetch_offer_with(f.host, f.port, allow).expect("offer");
            println!("OFFER {offer}");
            m::send_answer_with(f.host, f.port, &token, answer, allow).expect("answer");
            println!("SENT");
        }
        _ => {
            eprintln!("usage: lan-mdns-demo host <offer code> | join <answer code> [--want <label>] [--test-net]");
            std::process::exit(2);
        }
    }
}
