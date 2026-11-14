//! Plan W2.19: finding the other device on the local network from the
//! desktop app. The WebView can't use UDP or listen on a port, so these
//! commands run the `lumen-lan-mdns` crate (std only): announce this device
//! while its pairing dialog is open and serve its pairing code, or browse for
//! one and swap codes with it. The WebRTC link and the passphrase proof stay
//! in the app (src/sync/e2ee/lan/); this only replaces typing or scanning the
//! two codes. Nothing here reaches past the local network.

use lumen_lan_mdns as mdns;
use serde::Serialize;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

/// The pairing this device is offering, while its dialog is open.
#[derive(Default)]
pub struct DiscoveryState(Mutex<Option<(mdns::Advertiser, mdns::Rendezvous)>>);

#[derive(Serialize)]
pub struct Hosting {
    /// The name the other device lists ("Lumen-K7Q2"), shown here so the user picks the right one.
    pub name: String,
    pub port: u16,
}

#[derive(Serialize)]
pub struct FoundDevice {
    pub name: String,
    pub host: String,
    pub port: u16,
}

#[derive(Serialize)]
pub struct Offer {
    pub token: String,
    pub offer: String,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn lan_ip(host: &str) -> Result<IpAddr, String> {
    let ip: IpAddr = host.parse().map_err(err)?;
    if mdns::net::is_lan_ip(ip) {
        Ok(ip)
    } else {
        Err("not-lan".into())
    }
}

/// Announce this device and serve `offer` until an answer comes or `lan_discovery_stop`.
#[tauri::command]
pub fn lan_discovery_host(state: State<DiscoveryState>, offer: String) -> Result<Hosting, String> {
    let mut slot = state.0.lock().map_err(err)?;
    *slot = None; // the previous pairing's sockets close first
    let r = mdns::Rendezvous::start(offer).map_err(err)?;
    let name = mdns::instance_label();
    let a = mdns::Advertiser::start(name.clone(), r.port, vec!["v=1".into()]).map_err(err)?;
    let port = r.port;
    *slot = Some((a, r));
    Ok(Hosting { name, port })
}

/// The answer code a joining device sent, once (then this device stops announcing).
#[tauri::command]
pub fn lan_discovery_answer(state: State<DiscoveryState>) -> Result<Option<String>, String> {
    let mut slot = state.0.lock().map_err(err)?;
    let answer = slot.as_ref().and_then(|(_, r)| r.take_answer());
    if answer.is_some() {
        *slot = None;
    }
    Ok(answer)
}

#[tauri::command]
pub fn lan_discovery_stop(state: State<DiscoveryState>) -> Result<(), String> {
    *state.0.lock().map_err(err)? = None;
    Ok(())
}

/// The devices announcing a pairing on this network (local addresses only). Blocks for `ms`, off the main thread.
#[tauri::command(async)]
pub fn lan_discovery_browse(ms: u64) -> Result<Vec<FoundDevice>, String> {
    let found = mdns::browse(Duration::from_millis(ms.clamp(300, 10_000))).map_err(err)?;
    Ok(found.into_iter().map(|f| FoundDevice { name: f.name, host: f.host.to_string(), port: f.port }).collect())
}

#[tauri::command(async)]
pub fn lan_discovery_fetch_offer(host: String, port: u16) -> Result<Offer, String> {
    let (token, offer) = mdns::fetch_offer(lan_ip(&host)?, port).map_err(err)?;
    Ok(Offer { token, offer })
}

#[tauri::command(async)]
pub fn lan_discovery_send_answer(host: String, port: u16, token: String, answer: String) -> Result<(), String> {
    mdns::send_answer(lan_ip(&host)?, port, &token, &answer).map_err(err)
}
