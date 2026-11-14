//! Windows and tabs that move between them (plan W3.9).
//!
//! Every window shows the same app; a window's label names it (`main`,
//! `w-2`, `w-3`, …, and `capture` for the quick-capture window). A tab
//! dragged out of a window lands in the window under the pointer, or in a
//! new window when there is none.
//!
//! The move is two-phase so a tab is never lost or doubled: the source
//! *offers* the tab (its full editing state travels with the offer), the
//! target *accepts* it once it has opened it, and only then does the source
//! close its copy (*commit*). If the target never accepts (it was closed, or
//! the open failed), the offer is *cancelled* and the tab stays where it was.

use std::collections::HashMap;

pub const MAIN: &str = "main";
pub const CAPTURE: &str = "capture";

/// The label for a new editor window: the lowest free `w-N`, N ≥ 2.
pub fn next_label(existing: &[String]) -> String {
    let mut n = 2;
    loop {
        let l = format!("w-{n}");
        if !existing.iter().any(|e| *e == l) {
            return l;
        }
        n += 1;
    }
}

/// Editor windows are `main` and `w-N`; only these receive tabs.
pub fn is_editor_window(label: &str) -> bool {
    label == MAIN || label.strip_prefix("w-").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// A window's place on screen (physical pixels), front-most first.
#[derive(Debug, Clone, PartialEq)]
pub struct WinGeom {
    pub label: String,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub minimized: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DropTarget {
    Window(String),
    NewWindow { x: i32, y: i32 },
}

/// Where a tab dropped at screen point (x, y) goes: the front-most visible
/// editor window under the point other than its source, else a new window
/// there. Dropping back on the source window is not a move (`None`).
pub fn drop_target(x: i32, y: i32, source: &str, windows_front_to_back: &[WinGeom]) -> Option<DropTarget> {
    for w in windows_front_to_back {
        if w.minimized || !is_editor_window(&w.label) {
            continue;
        }
        let inside = x >= w.x && y >= w.y && (x as i64) < w.x as i64 + w.w as i64 && (y as i64) < w.y as i64 + w.h as i64;
        if inside {
            return if w.label == source { None } else { Some(DropTarget::Window(w.label.clone())) };
        }
    }
    // A new window, its title bar under the pointer (a little up and left).
    Some(DropTarget::NewWindow { x: x - 80, y: y - 16 })
}

#[derive(Debug, Clone, PartialEq)]
pub enum TransferError {
    UnknownTab,
    NotOwner,
    AlreadyOffered,
    NoOffer,
    WrongTarget,
    SameWindow,
}

#[derive(Debug, Clone, PartialEq)]
struct Offer {
    from: String,
    to: String,
    /// The tab's editing state, opaque here (JSON from the WebView: text,
    /// unsaved flag, cursor, selection, scroll, view mode).
    state: String,
}

/// Which window holds which tab, and the moves in flight.
#[derive(Default, Debug)]
pub struct Tabs {
    owner: HashMap<String, String>,
    offers: HashMap<String, Offer>,
}

impl Tabs {
    pub fn open(&mut self, tab: &str, window: &str) {
        self.owner.insert(tab.to_string(), window.to_string());
    }

    pub fn close(&mut self, tab: &str) {
        self.owner.remove(tab);
        self.offers.remove(tab);
    }

    pub fn owner(&self, tab: &str) -> Option<&str> {
        self.owner.get(tab).map(String::as_str)
    }

    /// Step 1: the source window offers the tab to `to`.
    pub fn offer(&mut self, tab: &str, from: &str, to: &str, state: String) -> Result<(), TransferError> {
        match self.owner.get(tab) {
            None => return Err(TransferError::UnknownTab),
            Some(o) if o != from => return Err(TransferError::NotOwner),
            _ => {}
        }
        if from == to {
            return Err(TransferError::SameWindow);
        }
        if self.offers.contains_key(tab) {
            return Err(TransferError::AlreadyOffered);
        }
        self.offers.insert(tab.to_string(), Offer { from: from.into(), to: to.into(), state });
        Ok(())
    }

    /// What the target opens: the offered state.
    pub fn offered_state(&self, tab: &str, to: &str) -> Option<&str> {
        self.offers.get(tab).filter(|o| o.to == to).map(|o| o.state.as_str())
    }

    /// Step 2: the target has opened the tab. Ownership moves; the source
    /// is told to close its copy (returns the source label).
    pub fn accept(&mut self, tab: &str, to: &str) -> Result<String, TransferError> {
        let offer = self.offers.get(tab).ok_or(TransferError::NoOffer)?;
        if offer.to != to {
            return Err(TransferError::WrongTarget);
        }
        let offer = self.offers.remove(tab).unwrap();
        self.owner.insert(tab.to_string(), offer.to);
        Ok(offer.from)
    }

    /// The target never accepted: the tab stays with its source.
    pub fn cancel(&mut self, tab: &str) -> Result<(), TransferError> {
        self.offers.remove(tab).map(|_| ()).ok_or(TransferError::NoOffer)
    }

    /// A window closed: its tabs are gone, offers *to* it are cancelled
    /// (their tabs stay with the source), offers *from* it are kept (the
    /// target may still accept the state it was sent).
    pub fn window_closed(&mut self, label: &str) -> Vec<String> {
        let cancelled: Vec<String> = self.offers.iter().filter(|(_, o)| o.to == label).map(|(t, _)| t.clone()).collect();
        for t in &cancelled {
            self.offers.remove(t);
        }
        let offered_away: Vec<String> = self.offers.iter().filter(|(_, o)| o.from == label).map(|(t, _)| t.clone()).collect();
        self.owner.retain(|t, w| w != label || offered_away.contains(t));
        cancelled
    }

    /// Tabs offered to `window` and not accepted yet (a new window asks on load).
    pub fn tabs_of_offers_to(&self, window: &str) -> Vec<String> {
        let mut v: Vec<String> = self.offers.iter().filter(|(_, o)| o.to == window).map(|(t, _)| t.clone()).collect();
        v.sort();
        v
    }

    pub fn tabs_of(&self, window: &str) -> Vec<String> {
        let mut v: Vec<String> = self.owner.iter().filter(|(_, w)| *w == window).map(|(t, _)| t.clone()).collect();
        v.sort();
        v
    }
}
