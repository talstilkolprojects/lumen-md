use crate::deeplink::{self, DeepLink, LinkError};
use crate::fileopen::{self, Placement, Standalone};
use crate::tray;
use crate::windows::{self, DropTarget, Tabs, TransferError, WinGeom};
use std::path::{Path, PathBuf};

// ── deep links ─────────────────────────────────────────────────────────

#[test]
fn open_links() {
    assert_eq!(
        deeplink::parse("lumen://open?path=notes/idea.md").unwrap(),
        DeepLink::Open { path: "notes/idea.md".into(), vault: None, line: None }
    );
    // Hebrew, percent-encoded, with a vault and a line.
    let l = format!("lumen://open?path={}&vault=%D7%9E%D7%97%D7%A7%D7%A8&line=12", deeplink::encode("סמינר/רעיון ראשון.md"));
    assert_eq!(
        deeplink::parse(&l).unwrap(),
        DeepLink::Open { path: "סמינר/רעיון ראשון.md".into(), vault: Some("מחקר".into()), line: Some(12) }
    );
    assert_eq!(deeplink::parse("lumen:open?path=a.md").unwrap(), DeepLink::Open { path: "a.md".into(), vault: None, line: None });
    assert_eq!(deeplink::parse("LUMEN://open?path=a.md"), Err(LinkError::NotLumen));
    // The round trip.
    let link = deeplink::open_link("סמינר/רעיון ראשון.md", Some("מחקר"));
    assert_eq!(deeplink::parse(&link).unwrap(), DeepLink::Open { path: "סמינר/רעיון ראשון.md".into(), vault: Some("מחקר".into()), line: None });
}

#[test]
fn open_links_refuse_paths_that_leave_the_vault() {
    for bad in ["../etc/passwd", "a/../../b.md", "/etc/passwd", "C:/Windows/x.md", "c:x.md", "a\\b.md", "a//b.md", "./a.md", "a/./b.md", "", "a%00b.md", "%2e%2e/x.md"] {
        let link = format!("lumen://open?path={bad}");
        assert_eq!(deeplink::parse(&link), Err(LinkError::BadPath), "{bad}");
    }
    assert_eq!(deeplink::parse("lumen://open"), Err(LinkError::Missing("path")));
    assert_eq!(deeplink::parse("lumen://open?path=a.md&vault=../x"), Err(LinkError::BadValue("vault")));
    assert_eq!(deeplink::parse("lumen://open?path=a.md&line=0"), Err(LinkError::BadValue("line")));
    assert_eq!(deeplink::parse("lumen://open?path=a.md&line=x"), Err(LinkError::BadValue("line")));
    assert_eq!(deeplink::parse("lumen://open?path=%ZZ"), Err(LinkError::BadEncoding));
    assert_eq!(deeplink::parse("lumen://delete?path=a.md"), Err(LinkError::UnknownAction("delete".into())));
    assert_eq!(deeplink::parse(&format!("lumen://open?path={}", "a".repeat(20_000))), Err(LinkError::TooLong));
}

#[test]
fn new_and_capture_links() {
    assert_eq!(deeplink::parse("lumen://new").unwrap(), DeepLink::New { title: None, text: None, folder: None });
    assert_eq!(deeplink::parse("lumen://new/").unwrap(), DeepLink::New { title: None, text: None, folder: None });
    assert_eq!(
        deeplink::parse("lumen://new?title=%D7%A8%D7%A2%D7%99%D7%95%D7%9F&text=line+one%0Aline+two&folder=inbox").unwrap(),
        DeepLink::New { title: Some("רעיון".into()), text: Some("line one\nline two".into()), folder: Some("inbox".into()) }
    );
    assert_eq!(deeplink::parse("lumen://new?title=a/b"), Err(LinkError::BadValue("title")));
    assert_eq!(deeplink::parse("lumen://new?folder=../x"), Err(LinkError::BadPath));
    assert_eq!(deeplink::parse("lumen://capture?text=%D7%9C%D7%A7%D7%A0%D7%95%D7%AA+%D7%97%D7%9C%D7%91").unwrap(), DeepLink::Capture { text: "לקנות חלב".into() });
    // Control characters other than newline and tab are dropped.
    assert_eq!(deeplink::parse("lumen://capture?text=a%1Bb").unwrap(), DeepLink::Capture { text: "ab".into() });
    assert_eq!(deeplink::parse("lumen://capture?text=+"), Err(LinkError::Missing("text")));
    assert_eq!(deeplink::parse("lumen://capture"), Err(LinkError::Missing("text")));
}

// ── opening files ──────────────────────────────────────────────────────

#[test]
fn a_file_opens_in_the_vault_that_holds_it() {
    let roots = vec!["/Users/tal/Notes".to_string(), "/Users/tal/Notes/Project".to_string(), "/Users/tal/Research".to_string()];
    assert_eq!(
        fileopen::place(Path::new("/Users/tal/Research/a/b.md"), &roots, false),
        Placement::InVault { root: "/Users/tal/Research".into(), rel: "a/b.md".into() }
    );
    // Nested vaults: the deepest one wins.
    assert_eq!(
        fileopen::place(Path::new("/Users/tal/Notes/Project/plan.md"), &roots, false),
        Placement::InVault { root: "/Users/tal/Notes/Project".into(), rel: "plan.md".into() }
    );
    assert_eq!(
        fileopen::place(Path::new("/Users/tal/Notes/inbox.md"), &roots, false),
        Placement::InVault { root: "/Users/tal/Notes".into(), rel: "inbox.md".into() }
    );
    // A sibling folder that only shares a prefix is not inside.
    assert_eq!(fileopen::place(Path::new("/Users/tal/NotesOld/x.md"), &roots, false), Placement::Standalone { path: PathBuf::from("/Users/tal/NotesOld/x.md") });
    // `..` is applied before comparing.
    assert_eq!(
        fileopen::place(Path::new("/Users/tal/Research/../Notes/x.md"), &roots, false),
        Placement::InVault { root: "/Users/tal/Notes".into(), rel: "x.md".into() }
    );
    // macOS / Windows compare without case; Linux with.
    assert_eq!(
        fileopen::place(Path::new("/users/TAL/research/x.md"), &roots, true),
        Placement::InVault { root: "/Users/tal/Research".into(), rel: "x.md".into() }
    );
    assert!(matches!(fileopen::place(Path::new("/users/TAL/research/x.md"), &roots, false), Placement::Standalone { .. }));
    // The vault folder itself is not a file in it.
    assert!(matches!(fileopen::place(Path::new("/Users/tal/Research"), &roots, false), Placement::Standalone { .. }));
}

#[test]
fn launch_arguments() {
    let args = ["-psn_0_12345", "--flag", "notes/a.md", "/abs/b.MARKDOWN", "pic.png", "lumen://open?path=x.md", "file:///abs/%D7%90.md", "board.excalidraw", "db.base"].map(String::from);
    let l = fileopen::parse_args(args, Path::new("/home/u"));
    assert_eq!(
        l.files,
        vec![
            PathBuf::from("/home/u/notes/a.md"),
            PathBuf::from("/abs/b.MARKDOWN"),
            PathBuf::from("/abs/א.md"),
            PathBuf::from("/home/u/board.excalidraw"),
            PathBuf::from("/home/u/db.base")
        ]
    );
    assert_eq!(l.links, vec!["lumen://open?path=x.md".to_string()]);
}

#[test]
fn standalone_files_are_reached_by_token_only() {
    let mut s = Standalone::default();
    let t = s.grant(PathBuf::from("/tmp/x/note.md"));
    assert_eq!(s.grant(PathBuf::from("/tmp/x/note.md")), t);
    let t2 = s.grant(PathBuf::from("/tmp/y.md"));
    assert_ne!(t, t2);
    assert_eq!(s.name(&t).as_deref(), Some("note.md"));
    assert_eq!(s.path("f999"), None);
    s.release(&t);
    assert_eq!(s.path(&t), None);
}

// ── windows and tabs ───────────────────────────────────────────────────

#[test]
fn window_labels() {
    assert_eq!(windows::next_label(&["main".into()]), "w-2");
    assert_eq!(windows::next_label(&["main".into(), "w-2".into(), "w-4".into()]), "w-3");
    assert!(windows::is_editor_window("main"));
    assert!(windows::is_editor_window("w-12"));
    assert!(!windows::is_editor_window("capture"));
    assert!(!windows::is_editor_window("w-"));
    assert!(!windows::is_editor_window("w-x"));
}

#[test]
fn where_a_dragged_tab_lands() {
    let g = |label: &str, x, y, w, h, minimized| WinGeom { label: label.into(), x, y, w, h, minimized };
    let wins = vec![g("w-2", 500, 100, 600, 400, false), g("main", 0, 0, 1280, 800, false), g("capture", 100, 100, 400, 200, false), g("w-3", 0, 0, 2000, 2000, true)];
    // Over w-2 (front-most): there.
    assert_eq!(windows::drop_target(600, 200, "main", &wins), Some(DropTarget::Window("w-2".into())));
    // Over main only: there, unless main is the source (not a move).
    assert_eq!(windows::drop_target(100, 700, "w-2", &wins), Some(DropTarget::Window("main".into())));
    assert_eq!(windows::drop_target(100, 700, "main", &wins), None);
    // The capture window and minimized windows don't take tabs.
    assert_eq!(windows::drop_target(150, 150, "w-2", &wins), Some(DropTarget::Window("main".into())));
    // Over nothing: a new window under the pointer.
    assert_eq!(windows::drop_target(1500, 900, "main", &wins), Some(DropTarget::NewWindow { x: 1420, y: 884 }));
}

#[test]
fn a_tab_moves_in_two_phases_and_is_never_lost_or_doubled() {
    let mut t = Tabs::default();
    t.open("notes/a.md", "main");
    let state = r#"{"content":"draft","dirty":true,"cursor":12}"#.to_string();
    assert_eq!(t.offer("notes/a.md", "w-2", "main", state.clone()), Err(TransferError::NotOwner));
    assert_eq!(t.offer("nope", "main", "w-2", state.clone()), Err(TransferError::UnknownTab));
    assert_eq!(t.offer("notes/a.md", "main", "main", state.clone()), Err(TransferError::SameWindow));
    t.offer("notes/a.md", "main", "w-2", state.clone()).unwrap();
    assert_eq!(t.offer("notes/a.md", "main", "w-3", state.clone()), Err(TransferError::AlreadyOffered));
    // Still owned by the source until the target accepts; the target reads the full state.
    assert_eq!(t.owner("notes/a.md"), Some("main"));
    assert_eq!(t.tabs_of_offers_to("w-2"), vec!["notes/a.md".to_string()]);
    assert!(t.tabs_of_offers_to("w-3").is_empty());
    assert_eq!(t.offered_state("notes/a.md", "w-2"), Some(state.as_str()));
    assert_eq!(t.offered_state("notes/a.md", "w-3"), None);
    assert_eq!(t.accept("notes/a.md", "w-3"), Err(TransferError::WrongTarget));
    assert_eq!(t.accept("notes/a.md", "w-2"), Ok("main".to_string()));
    assert_eq!(t.owner("notes/a.md"), Some("w-2"));
    assert!(t.tabs_of_offers_to("w-2").is_empty());
    assert_eq!(t.accept("notes/a.md", "w-2"), Err(TransferError::NoOffer));
}

#[test]
fn a_target_that_closes_cancels_the_move() {
    let mut t = Tabs::default();
    t.open("a.md", "main");
    t.open("b.md", "w-2");
    t.offer("a.md", "main", "w-2", "{}".into()).unwrap();
    let cancelled = t.window_closed("w-2");
    assert_eq!(cancelled, vec!["a.md".to_string()]);
    assert_eq!(t.owner("a.md"), Some("main"));
    assert_eq!(t.owner("b.md"), None);
    // A source that closes after offering: the target can still accept.
    t.open("c.md", "w-3");
    t.offer("c.md", "w-3", "main", "{}".into()).unwrap();
    t.window_closed("w-3");
    assert_eq!(t.accept("c.md", "main"), Ok("w-3".to_string()));
    assert_eq!(t.tabs_of("main"), vec!["a.md".to_string(), "c.md".to_string()]);
    assert_eq!(t.cancel("a.md"), Err(TransferError::NoOffer));
}

// ── tray and quick capture ─────────────────────────────────────────────

#[test]
fn tray_menu() {
    let he = tray::Labels { capture: "לכידה מהירה…".into(), new_note: "פתק חדש".into(), recent: "פתקים אחרונים".into(), show: "הצגת Lumen".into(), quit: "יציאה מ-Lumen".into() };
    let recent: Vec<String> = (1..=7).map(|i| format!("פתק מספר {i} עם שם ארוך מאוד שלא נכנס בתפריט המגש")).collect();
    let m = tray::menu(&he, &recent);
    assert_eq!(m[0], tray::Item::Action { id: tray::CAPTURE.into(), label: "לכידה מהירה…".into() });
    let recents: Vec<_> = m.iter().filter_map(|i| match i { tray::Item::Action { id, label } if id.starts_with("recent:") => Some(label.clone()), _ => None }).collect();
    assert_eq!(recents.len(), tray::MAX_RECENT);
    assert!(recents.iter().all(|l| l.chars().count() <= 40 && l.ends_with('…')));
    assert_eq!(m.last(), Some(&tray::Item::Action { id: tray::QUIT.into(), label: "יציאה מ-Lumen".into() }));
    assert!(!tray::menu(&tray::Labels::default(), &[]).iter().any(|i| matches!(i, tray::Item::Header(_))));
    assert_eq!(tray::recent_index("recent:3"), Some(3));
    assert_eq!(tray::recent_index("recent:9"), None);
    assert_eq!(tray::shorten("אבג", 3), "אבג");
    assert_eq!(tray::shorten("אבגד", 3), "אב…");
}

#[test]
fn quick_capture_entries() {
    // 2025-11-10 08:05 UTC; 2026-11-10 08:05 UTC in Israel winter time (+120 minutes).
    assert_eq!(tray::stamp(1_762_761_900, 0), "2025-11-10 08:05");
    assert_eq!(tray::stamp(1_794_297_900, 120), "2026-11-10 10:05");
    assert_eq!(tray::stamp(0, 0), "1970-01-01 00:00");
    assert_eq!(tray::stamp(951_782_400, 0), "2000-02-29 00:00");
    assert_eq!(tray::capture_entry("  לקנות חלב  ", 0, 0).as_deref(), Some("- 1970-01-01 00:00 לקנות חלב\n"));
    assert_eq!(tray::capture_entry("רעיון\nפרט ראשון\n\n  פרט שני", 0, 0).as_deref(), Some("- 1970-01-01 00:00 רעיון\n  פרט ראשון\n\n  פרט שני\n"));
    assert_eq!(tray::capture_entry("   \n ", 0, 0), None);
    assert_eq!(tray::append_to_inbox("", "- x\n"), "- x\n");
    assert_eq!(tray::append_to_inbox("# Inbox\n", "- x\n"), "# Inbox\n- x\n");
    assert_eq!(tray::append_to_inbox("# Inbox", "- x\n"), "# Inbox\n- x\n");
}
