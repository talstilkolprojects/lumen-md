//! Desktop updates (plan 11.5.1): `tauri-plugin-updater`, driven from Rust
//! commands so the WebView never talks to the update server itself. Since
//! W11.S2 the commands take no parameters (`lumen_check_update`,
//! `lumen_install_update`), the manifest's own signature (latest.json.sig) is
//! verified before it is read (manifest_sig.rs), and the channel is a
//! separate, two-valued setting (`lumen_set_update_channel`).
//!
//! The update key and servers are build settings, not code:
//!   LUMEN_UPDATER_PUBKEY         minisign public key (Tal's, plan 15.7)
//!   LUMEN_UPDATER_ENDPOINT       https URL of the stable latest.json (GitHub Releases)
//!   LUMEN_UPDATER_ENDPOINT_BETA  https URL of the beta channel's latest.json (plan 14.4);
//!                                without it, the beta channel follows stable
//! The WebView may pick a channel ("stable" or "beta"), never a URL.
//! A build without them has no updater: the commands say so, and nothing
//! is ever fetched. Checks run only when the user asks (or turns on
//! automatic checks); the app's privacy policy is enforced by the caller.

use serde::Serialize;

/// Which releases a user follows (plan 14.4).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Channel {
    Stable,
    Beta,
}

impl Channel {
    /// Anything but "beta" is stable, so a bad value never widens what is installed.
    pub fn parse(s: Option<&str>) -> Channel {
        match s.map(str::trim) {
            Some("beta") => Channel::Beta,
            _ => Channel::Stable,
        }
    }
}

/// The endpoint for a channel, from the build's settings: beta uses its own
/// endpoint when the build has one, and the stable one otherwise.
pub fn endpoint_for(channel: Channel, stable: &'static str, beta: &'static str) -> Option<&'static str> {
    let pick = match channel {
        Channel::Beta if valid_endpoint(beta.trim()) => beta.trim(),
        _ => stable.trim(),
    };
    valid_endpoint(pick).then_some(pick)
}

/// The build's update settings for a channel, if it has them.
pub fn configured(channel: Channel) -> Option<(&'static str, &'static str)> {
    let key = option_env!("LUMEN_UPDATER_PUBKEY").unwrap_or("").trim();
    let url = endpoint_for(
        channel,
        option_env!("LUMEN_UPDATER_ENDPOINT").unwrap_or(""),
        option_env!("LUMEN_UPDATER_ENDPOINT_BETA").unwrap_or(""),
    )?;
    if key.is_empty() {
        return None;
    }
    Some((key, url))
}

/// Only https, and only GitHub Releases or our own release host.
pub fn valid_endpoint(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split('/').next().unwrap_or("");
    !host.is_empty() && (host == "github.com" || host.ends_with(".github.io") || host == "objects.githubusercontent.com")
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum UpdateStatus {
    /// This build has no update key / server (plan 15.7 not done yet).
    NotConfigured,
    UpToDate { current: String },
    Available { current: String, version: String, notes: Option<String> },
}

/// The Ed25519 check of a minisign signature, as tauri-plugin-updater makes it
/// for each bundle (`minisign-verify`, legacy signatures allowed like the
/// plugin): `sig_text` and `key_text` are the decoded minisign files.
pub fn minisign_check(data: &[u8], sig_text: &str, key_text: &str) -> bool {
    let Ok(key) = minisign_verify::PublicKey::decode(key_text) else { return false };
    let Ok(sig) = minisign_verify::Signature::decode(sig_text) else { return false };
    key.verify(data, &sig, true).is_ok()
}

/// The build's own channel: the one the release script built it for
/// (`VITE_LUMEN_CHANNEL`, the same setting as the web build's).
pub fn build_channel() -> Channel {
    Channel::parse(option_env!("VITE_LUMEN_CHANNEL"))
}

#[cfg(desktop)]
pub mod imp {
    use super::{build_channel, configured, minisign_check, Channel, UpdateStatus};
    use crate::{manifest_sig, update_guard};
    use std::sync::Mutex;
    use tauri::Manager;
    use tauri_plugin_updater::UpdaterExt;

    /// W11.S2: the update the last check verified; `lumen_install_update`
    /// installs this one and nothing else.
    #[derive(Default)]
    pub struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

    /// W10.D9: the highest version ever installed on this machine, kept in
    /// the app data dir and raised to the running version on every check.
    fn highest_installed(app: &tauri::AppHandle) -> Option<String> {
        let dir = app.path().app_data_dir().ok()?;
        let file = dir.join("highest-installed-version");
        let recorded = std::fs::read_to_string(&file).ok();
        let current = app.package_info().version.to_string();
        let top = update_guard::highest(&current, recorded.as_deref());
        if recorded.as_deref().map(str::trim) != Some(top.as_str()) {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(&file, &top);
        }
        Some(top)
    }

    /// The user's channel (`lumen_set_update_channel`), else the build's.
    fn channel(app: &tauri::AppHandle) -> Channel {
        let file = app.path().app_data_dir().ok().map(|d| d.join("update-channel"));
        match file.and_then(|f| std::fs::read_to_string(f).ok()) {
            Some(s) => Channel::parse(Some(s.as_str())),
            None => build_channel(),
        }
    }

    /// GET a release file: https only (the endpoint is checked), bounded size.
    async fn fetch(url: &str) -> Result<Option<Vec<u8>>, String> {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
        let res = client.get(url).send().await.map_err(|e| e.to_string())?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let res = res.error_for_status().map_err(|e| e.to_string())?;
        let body = res.bytes().await.map_err(|e| e.to_string())?;
        if body.len() > manifest_sig::MAX_MANIFEST_BYTES {
            return Err(manifest_sig::Refusal::TooLarge.message().into());
        }
        Ok(Some(body.to_vec()))
    }

    /// Check for an update; nothing comes from the WebView. Steps (W11.S2):
    /// the manifest and its signature are fetched here and verified with the
    /// build's updater key before anything in them is read; the version must
    /// be newer than the running one and the highest ever installed; the
    /// plugin then checks too (same comparator), and its manifest must be the
    /// verified one. The result is kept for `lumen_install_update`.
    #[tauri::command]
    pub async fn lumen_check_update(app: tauri::AppHandle, pending: tauri::State<'_, PendingUpdate>) -> Result<UpdateStatus, String> {
        *pending.0.lock().map_err(|e| e.to_string())? = None;
        let current = app.package_info().version.to_string();
        let Some((key, url)) = configured(channel(&app)) else { return Ok(UpdateStatus::NotConfigured) };
        let Some(manifest) = fetch(url).await? else { return Err("the update manifest (latest.json) was not found".into()) };
        let sig = fetch(&manifest_sig::sig_url(url)).await?;
        manifest_sig::verify_manifest(&manifest, sig.as_deref(), key, minisign_check).map_err(|r| r.message().to_string())?;
        // Read only from the verified bytes.
        let verified: serde_json::Value = serde_json::from_slice(&manifest).map_err(|e| format!("the signed update manifest is not JSON: {e}"))?;
        let Some(version) = verified.get("version").and_then(|v| v.as_str()) else { return Err("the signed update manifest has no version".into()) };
        let recorded = highest_installed(&app);
        if !update_guard::accept(&current, version, recorded.as_deref()) {
            return Ok(UpdateStatus::UpToDate { current });
        }
        let endpoint = url.parse().map_err(|e| format!("{e}"))?;
        let u = app
            .updater_builder()
            .pubkey(key)
            // W10.D9 (CVE-2026-95625): an older but validly signed build is
            // refused here too, and so is anything below the highest version
            // this machine ever ran.
            .version_comparator(move |current, remote| update_guard::accept(&current.to_string(), &remote.version.to_string(), recorded.as_deref()))
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())?;
        match u.check().await.map_err(|e| e.to_string())? {
            Some(up) => {
                // The plugin fetched latest.json again: it must be the manifest verified above.
                if up.raw_json != verified {
                    return Err("the update manifest changed after it was verified: update refused".into());
                }
                let status = UpdateStatus::Available { current, version: up.version.clone(), notes: up.body.clone() };
                *pending.0.lock().map_err(|e| e.to_string())? = Some(up);
                Ok(status)
            }
            None => Ok(UpdateStatus::UpToDate { current }),
        }
    }

    /// Install the update the last check verified: download, verify the
    /// bundle's signature (the plugin refuses an unsigned or wrongly signed
    /// file) and install; the app restarts. No parameters: the WebView can
    /// only say "install it".
    #[tauri::command]
    pub async fn lumen_install_update(app: tauri::AppHandle, pending: tauri::State<'_, PendingUpdate>) -> Result<(), String> {
        let up = pending.0.lock().map_err(|e| e.to_string())?.take();
        let Some(up) = up else { return Err("no verified update: check for updates first".into()) };
        up.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        app.restart();
    }

    /// The user's update channel (BetaPanel, plan 14.4): "beta" or "stable"
    /// (anything else is stable). It only picks one of the build's two
    /// endpoints; the update commands themselves take nothing from the WebView.
    #[tauri::command]
    pub fn lumen_set_update_channel(app: tauri::AppHandle, channel: String) -> Result<(), String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let value = match Channel::parse(Some(channel.as_str())) {
            Channel::Beta => "beta",
            Channel::Stable => "stable",
        };
        std::fs::write(dir.join("update-channel"), value).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_must_be_https_on_a_release_host() {
        assert!(valid_endpoint("https://github.com/talstilkol/lumen-md/releases/latest/download/latest.json"));
        assert!(!valid_endpoint("http://github.com/x/latest.json"));
        assert!(!valid_endpoint("https://evil.example/latest.json"));
        assert!(!valid_endpoint("https://github.com.evil.example/latest.json"));
        assert!(!valid_endpoint(""));
    }

    #[test]
    fn a_build_without_a_key_has_no_updater() {
        // CI and local builds do not set LUMEN_UPDATER_PUBKEY.
        if option_env!("LUMEN_UPDATER_PUBKEY").is_none() {
            assert_eq!(configured(Channel::Stable), None);
            assert_eq!(configured(Channel::Beta), None);
        }
    }

    #[test]
    fn beta_has_its_own_endpoint_and_falls_back_to_stable() {
        let stable = "https://github.com/talstilkol/lumen-md/releases/latest/download/latest.json";
        let beta = "https://github.com/talstilkol/lumen-md/releases/download/beta-channel/latest.json";
        assert_eq!(endpoint_for(Channel::Stable, stable, beta), Some(stable));
        assert_eq!(endpoint_for(Channel::Beta, stable, beta), Some(beta));
        assert_eq!(endpoint_for(Channel::Beta, stable, ""), Some(stable));
        // A beta endpoint off the release hosts is ignored, never used.
        assert_eq!(endpoint_for(Channel::Beta, stable, "https://evil.example/latest.json"), Some(stable));
        assert_eq!(endpoint_for(Channel::Stable, "", beta), None);
        assert_eq!(Channel::parse(Some("beta")), Channel::Beta);
        assert_eq!(Channel::parse(Some("nightly")), Channel::Stable);
        assert_eq!(Channel::parse(None), Channel::Stable);
    }

    /// W11.S2/S3: the vectors scripts/release-run.mjs's signer made
    /// (src-tauri/tests/fixtures/manifest-sig-vectors.json) verify here with
    /// the real minisign check, and every tampered case is refused.
    #[test]
    fn release_signed_manifests_verify_with_minisign() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/manifest-sig-vectors.json")).unwrap();
        let key = v.get("pubkey").and_then(|k| k.as_str()).unwrap();
        let cases = v.get("cases").and_then(|c| c.as_array()).unwrap();
        assert!(cases.len() >= 5);
        for c in cases {
            let field = |k: &str| c.get(k).and_then(|x| x.as_str());
            let manifest = field("manifest").unwrap().as_bytes();
            let sig = field("sig").map(str::as_bytes);
            let got = crate::manifest_sig::verify_manifest(manifest, sig, field("pubkey").unwrap_or(key), minisign_check);
            let want = field("expect").unwrap();
            let got = match got {
                Ok(()) => "ok",
                Err(crate::manifest_sig::Refusal::Unsigned) => "unsigned",
                Err(crate::manifest_sig::Refusal::Malformed) => "malformed",
                Err(crate::manifest_sig::Refusal::BadSignature) => "bad-signature",
                Err(crate::manifest_sig::Refusal::TooLarge) => "too-large",
            };
            assert_eq!(got, want, "{}", field("name").unwrap_or("?"));
        }
    }

    #[test]
    fn status_serialises_for_the_webview() {
        let s = serde_json::to_string(&UpdateStatus::Available { current: "0.1.0".into(), version: "0.2.0".into(), notes: None }).unwrap();
        assert_eq!(s, r#"{"state":"available","current":"0.1.0","version":"0.2.0","notes":null}"#);
        assert_eq!(serde_json::to_string(&UpdateStatus::NotConfigured).unwrap(), r#"{"state":"not-configured"}"#);
    }
}
