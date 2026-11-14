//! Desktop updates (plan 11.5.1): `tauri-plugin-updater`, driven from two
//! commands so the WebView never talks to the update server itself.
//!
//! The update key and server are build settings, not code:
//!   LUMEN_UPDATER_PUBKEY    minisign public key (Tal's, plan 15.7)
//!   LUMEN_UPDATER_ENDPOINT  https URL of latest.json (GitHub Releases)
//! A build without them has no updater: the commands say so, and nothing
//! is ever fetched. Checks run only when the user asks (or turns on
//! automatic checks); the app's privacy policy is enforced by the caller.

use serde::Serialize;

/// The build's update settings, if it has them.
pub fn configured() -> Option<(&'static str, &'static str)> {
    let key = option_env!("LUMEN_UPDATER_PUBKEY").unwrap_or("").trim();
    let url = option_env!("LUMEN_UPDATER_ENDPOINT").unwrap_or("").trim();
    if key.is_empty() || !valid_endpoint(url) {
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

#[cfg(desktop)]
pub mod imp {
    use super::{configured, UpdateStatus};
    use tauri_plugin_updater::UpdaterExt;

    fn updater(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Updater>, String> {
        let Some((key, url)) = configured() else { return Ok(None) };
        let endpoint = url.parse().map_err(|e| format!("{e}"))?;
        app.updater_builder()
            .pubkey(key)
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?
            .build()
            .map(Some)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
        let current = app.package_info().version.to_string();
        let Some(u) = updater(&app)? else { return Ok(UpdateStatus::NotConfigured) };
        match u.check().await.map_err(|e| e.to_string())? {
            Some(up) => Ok(UpdateStatus::Available { current, version: up.version, notes: up.body }),
            None => Ok(UpdateStatus::UpToDate { current }),
        }
    }

    /// Download, verify the signature (the plugin refuses an unsigned or
    /// wrongly signed file) and install; the app restarts.
    #[tauri::command]
    pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
        let Some(u) = updater(&app)? else { return Err("updates are not configured in this build".into()) };
        let Some(up) = u.check().await.map_err(|e| e.to_string())? else { return Ok(()) };
        up.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        app.restart();
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
            assert_eq!(configured(), None);
        }
    }

    #[test]
    fn status_serialises_for_the_webview() {
        let s = serde_json::to_string(&UpdateStatus::Available { current: "0.1.0".into(), version: "0.2.0".into(), notes: None }).unwrap();
        assert_eq!(s, r#"{"state":"available","current":"0.1.0","version":"0.2.0","notes":null}"#);
        assert_eq!(serde_json::to_string(&UpdateStatus::NotConfigured).unwrap(), r#"{"state":"not-configured"}"#);
    }
}
