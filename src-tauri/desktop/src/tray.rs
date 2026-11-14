//! The tray icon (plan W3.9): quick capture from anywhere, a new note, the
//! recent notes, show / quit. Menu labels come from the WebView in the UI
//! language (`tray_set_menu`), so Hebrew users get a Hebrew tray; until it
//! sends them, English defaults are used.

/// Fixed item ids; recent notes are `recent:<n>`.
pub const CAPTURE: &str = "tray.capture";
pub const NEW_NOTE: &str = "tray.new";
pub const SHOW: &str = "tray.show";
pub const QUIT: &str = "tray.quit";
pub const MAX_RECENT: usize = 5;

#[derive(Debug, Clone, PartialEq)]
pub struct Labels {
    pub capture: String,
    pub new_note: String,
    pub recent: String,
    pub show: String,
    pub quit: String,
}

impl Default for Labels {
    fn default() -> Self {
        Labels { capture: "Quick capture…".into(), new_note: "New note".into(), recent: "Recent notes".into(), show: "Show Lumen".into(), quit: "Quit Lumen".into() }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    Action { id: String, label: String },
    Header(String),
    Separator,
}

/// Shorten a label for a menu (by characters, so Hebrew is never cut mid-letter).
pub fn shorten(s: &str, max: usize) -> String {
    let clean: String = s.chars().filter(|c| !c.is_control()).collect();
    if clean.chars().count() <= max {
        return clean;
    }
    let mut out: String = clean.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The tray menu, top to bottom. `recent` are display names (not paths).
pub fn menu(labels: &Labels, recent: &[String]) -> Vec<Item> {
    let mut v = vec![
        Item::Action { id: CAPTURE.into(), label: labels.capture.clone() },
        Item::Action { id: NEW_NOTE.into(), label: labels.new_note.clone() },
    ];
    if !recent.is_empty() {
        v.push(Item::Separator);
        v.push(Item::Header(labels.recent.clone()));
        for (i, r) in recent.iter().take(MAX_RECENT).enumerate() {
            v.push(Item::Action { id: format!("recent:{i}"), label: shorten(r, 40) });
        }
    }
    v.push(Item::Separator);
    v.push(Item::Action { id: SHOW.into(), label: labels.show.clone() });
    v.push(Item::Action { id: QUIT.into(), label: labels.quit.clone() });
    v
}

/// `recent:<n>` → n.
pub fn recent_index(id: &str) -> Option<usize> {
    id.strip_prefix("recent:")?.parse().ok().filter(|n| *n < MAX_RECENT)
}

/// Days from 1970-01-01 to a civil date (Howard Hinnant's algorithm), and back.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DD HH:MM` for local time, given seconds since the epoch and the
/// local offset from UTC in minutes.
pub fn stamp(unix_secs: i64, offset_minutes: i32) -> String {
    let t = unix_secs + offset_minutes as i64 * 60;
    let days = t.div_euclid(86_400);
    let secs = t.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", secs / 3600, (secs % 3600) / 60)
}

/// The line quick capture appends to the inbox: `- YYYY-MM-DD HH:MM text`.
/// Multi-line text becomes one item with its lines indented under it.
/// Empty text is nothing to add.
pub fn capture_entry(text: &str, unix_secs: i64, offset_minutes: i32) -> Option<String> {
    let lines: Vec<&str> = text.trim().lines().map(str::trim_end).collect();
    let first = lines.first().filter(|l| !l.trim().is_empty())?;
    let mut out = format!("- {} {}", stamp(unix_secs, offset_minutes), first.trim());
    for l in &lines[1..] {
        out.push('\n');
        if !l.trim().is_empty() {
            out.push_str("  ");
            out.push_str(l.trim_start());
        }
    }
    out.push('\n');
    Some(out)
}

/// The inbox's new text: `existing` plus the entry, on its own line.
pub fn append_to_inbox(existing: &str, entry: &str) -> String {
    if existing.is_empty() {
        return entry.to_string();
    }
    if existing.ends_with('\n') {
        format!("{existing}{entry}")
    } else {
        format!("{existing}\n{entry}")
    }
}
