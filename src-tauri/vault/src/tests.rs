//! The TypeScript contract cases (src/__tests__/vaultBackend.contract.test.ts)
//! on a real folder, plus the scope checks and a 1,000-note vault.
use super::*;

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn vault() -> (Tmp, Vault) {
    let n = TMP.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("lumen-vault-test-{}-{n}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let v = Vault::open(&dir).unwrap();
    (Tmp(dir), v)
}
fn code<T: fmt::Debug>(r: Result<T>) -> &'static str {
    r.map(|_| "ok").unwrap_or_else(|e| e.code)
}
fn names(v: &Vault, dir: &str) -> Vec<String> {
    v.list(dir).unwrap().into_iter().map(|e| e.name).collect()
}

#[test]
fn create_read_overwrite_and_bytes() {
    let (_t, v) = vault();
    v.write("a.md", b"a long first version").unwrap();
    v.write("a.md", b"short").unwrap();
    assert_eq!(v.read("a.md").unwrap(), b"short");
    assert_eq!(v.stat("a.md").unwrap().unwrap().size, 5);
    let raw = [0u8, 255, 128, 10, 13, 0];
    v.write("b.bin", &raw).unwrap();
    assert_eq!(v.read("b.bin").unwrap(), raw);
    v.write("empty.md", b"").unwrap();
    assert_eq!(
        v.stat("empty.md").unwrap().unwrap(),
        Stat {
            kind: "file",
            size: 0,
            mtime: v.stat("empty.md").unwrap().unwrap().mtime
        }
    );
    // No temporary files left behind.
    assert_eq!(names(&v, ""), vec!["a.md", "b.bin", "empty.md"]);
}

#[test]
fn nested_folders_and_mkdir() {
    let (_t, v) = vault();
    v.write("/a//b/c/note.md", b"deep").unwrap();
    assert_eq!(v.read("a/b/c/note.md").unwrap(), b"deep");
    assert_eq!(v.stat("a/b").unwrap().unwrap().kind, "directory");
    v.mkdir("x/y/z").unwrap();
    v.mkdir("x/y/z").unwrap();
    v.mkdir("").unwrap();
    assert!(v.list("x/y/z").unwrap().is_empty());
    assert_eq!(v.list("a/b").unwrap()[0].path, "a/b/c");
}

#[test]
fn rename_files_and_folders() {
    let (_t, v) = vault();
    v.write("old.md", b"body").unwrap();
    v.rename("old.md", "archive/2026/new.md", false).unwrap();
    assert_eq!(v.read("archive/2026/new.md").unwrap(), b"body");
    assert_eq!(v.stat("old.md").unwrap(), None);
    v.write("p/one.md", b"1").unwrap();
    v.write("p/sub/two.md", b"2").unwrap();
    v.rename("p", "q/moved", false).unwrap();
    assert_eq!(v.read("q/moved/sub/two.md").unwrap(), b"2");
    assert_eq!(v.stat("p").unwrap(), None);
}

#[test]
fn rename_conflicts_overwrite_and_refusals() {
    let (_t, v) = vault();
    v.write("a.md", b"A").unwrap();
    v.write("b.md", b"B").unwrap();
    v.write("dir/x.md", b"X").unwrap();
    assert_eq!(code(v.rename("a.md", "b.md", false)), "EEXIST");
    assert_eq!(code(v.rename("a.md", "dir", false)), "EEXIST");
    v.rename("a.md", "b.md", true).unwrap();
    assert_eq!(v.read("b.md").unwrap(), b"A");
    v.write("src/new.md", b"new").unwrap();
    v.write("dst/old.md", b"old").unwrap();
    v.rename("src", "dst", true).unwrap();
    assert_eq!(names(&v, "dst"), vec!["new.md"]);
    v.write("p/a.md", b"A").unwrap();
    assert_eq!(code(v.rename("p", "p/inner", false)), "EINVAL");
    v.write("t/b/c.md", b"C").unwrap();
    assert_eq!(code(v.rename("t/b", "t", true)), "EINVAL");
    assert_eq!(v.read("t/b/c.md").unwrap(), b"C");
    assert_eq!(code(v.rename("missing.md", "x.md", false)), "ENOENT");
    assert_eq!(code(v.rename("", "x", false)), "EINVAL");
    v.rename("b.md", "b.md", false).unwrap();
}

#[test]
fn case_only_rename() {
    let (_t, v) = vault();
    v.write("Note.md", b"N").unwrap();
    v.rename("Note.md", "note.md", false).unwrap();
    assert_eq!(names(&v, ""), vec!["note.md"]);
    assert_eq!(v.read("note.md").unwrap(), b"N");
}

#[test]
fn delete_and_errors() {
    let (_t, v) = vault();
    v.write("d/sub/a.md", b"A").unwrap();
    v.write("keep.md", b"K").unwrap();
    v.remove("d").unwrap();
    assert_eq!(names(&v, ""), vec!["keep.md"]);
    assert_eq!(code(v.remove("nope.md")), "ENOENT");
    assert_eq!(code(v.remove("")), "EINVAL");
    assert_eq!(code(v.read("nope.md")), "ENOENT");
    v.mkdir("dir").unwrap();
    assert_eq!(code(v.read("dir")), "ENOENT");
    assert_eq!(code(v.list("keep.md")), "ENOENT");
    assert_eq!(code(v.list("missing")), "ENOENT");
    assert_eq!(code(v.write("dir", b"x")), "EKIND");
    assert_eq!(code(v.write("keep.md/below.md", b"x")), "EKIND");
    assert_eq!(code(v.mkdir("keep.md")), "EKIND");
    assert_eq!(v.stat("keep.md/below").unwrap(), None);
    assert_eq!(v.stat("missing/x.md").unwrap(), None);
}

#[test]
fn list_order() {
    let (_t, v) = vault();
    for f in ["b.md", "c.txt", "a.md", "alpha/inside.md"] {
        v.write(f, b"x").unwrap();
    }
    v.mkdir("zeta").unwrap();
    v.write(".trash/index.json", b"[]").unwrap();
    assert_eq!(
        names(&v, ""),
        vec![".trash", "alpha", "zeta", "a.md", "b.md", "c.txt"]
    );
}

#[test]
fn paths_cannot_leave_the_vault() {
    let (t, v) = vault();
    v.write("a.md", b"a").unwrap();
    let mut bad = vec!["../x.md", "a/../../x.md", "./a.md", "..", "a\0b"];
    if cfg!(windows) {
        bad.extend(["a\\..\\x", "C:/x"]);
    }
    for p in bad {
        assert_eq!(code(v.read(p)), "EINVAL", "{p}");
        assert_eq!(code(v.write(p, b"x")), "EINVAL", "{p}");
    }
    assert_eq!(code(v.rename("a.md", "../a.md", false)), "EINVAL");
    // A symlink inside the folder that points outside it.
    #[cfg(unix)]
    {
        let outside = t.0.with_extension("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"s").unwrap();
        std::os::unix::fs::symlink(&outside, t.0.join("link")).unwrap();
        assert_eq!(code(v.read("link/secret.txt")), "EINVAL");
        assert_eq!(code(v.write("link/new.txt", b"x")), "EINVAL");
        assert!(!outside.join("new.txt").exists());
        let _ = fs::remove_dir_all(&outside);
    }
}

#[test]
fn hebrew_and_unicode_names() {
    let (_t, v) = vault();
    let text = "שלום עולם — مرحبا — こんにちは 🎉";
    v.write("פרויקטים/סיכום 2026.md", text.as_bytes()).unwrap();
    assert_eq!(v.read("פרויקטים/סיכום 2026.md").unwrap(), text.as_bytes());
    assert_eq!(names(&v, "פרויקטים"), vec!["סיכום 2026.md"]);
    v.rename("פרויקטים", "ארכיון/ישנים", false).unwrap();
    assert_eq!(
        v.read("ארכיון/ישנים/סיכום 2026.md").unwrap(),
        text.as_bytes()
    );
}

#[test]
fn a_thousand_notes_round_trip() {
    let (_t, v) = vault();
    for i in 0..1000 {
        v.write(
            &format!("הערות/{}/פתק {i}.md", i / 100),
            format!("# פתק {i}\n").as_bytes(),
        )
        .unwrap();
    }
    let mut n = 0;
    for d in v.list("הערות").unwrap() {
        for f in v.list(&d.path).unwrap() {
            let i: usize = f
                .name
                .trim_start_matches("פתק ")
                .trim_end_matches(".md")
                .parse()
                .unwrap();
            assert_eq!(v.read(&f.path).unwrap(), format!("# פתק {i}\n").as_bytes());
            n += 1;
        }
    }
    assert_eq!(n, 1000);
}

#[cfg(unix)]
#[test]
fn unix_names_with_colon_and_backslash_stay_addressable() {
    let (_t, v) = vault();
    for name in ["a:b.md", "x\\y.md", "meeting 10:30.md"] {
        v.write(name, b"n").unwrap();
        assert_eq!(v.read(name).unwrap(), b"n");
        assert!(names(&v, "").contains(&name.to_string()));
    }
    v.rename("a:b.md", "c:d.md", false).unwrap();
    v.remove("c:d.md").unwrap();
}

#[cfg(unix)]
#[test]
fn a_folder_symlink_is_not_listed_so_walks_end() {
    let (t, v) = vault();
    v.write("notes/a.md", b"A").unwrap();
    std::os::unix::fs::symlink(&t.0, t.0.join("notes/loop")).unwrap();
    std::os::unix::fs::symlink(t.0.join("notes/a.md"), t.0.join("notes/alias.md")).unwrap();
    assert_eq!(names(&v, "notes"), vec!["a.md", "alias.md"]);
}

#[cfg(unix)]
#[test]
fn a_planted_temp_symlink_is_never_followed() {
    let (t, v) = vault();
    let outside = t.0.with_extension("victim");
    fs::write(&outside, b"keep me").unwrap();
    // Plant symlinks at the next temporary names this process would use
    // (other tests run in parallel and take numbers too: plant plenty).
    let next = TMP.load(Ordering::Relaxed);
    for n in next..next + 40 {
        let _ = std::os::unix::fs::symlink(
            &outside,
            t.0.join(format!(".lumen-tmp-{}-{n}", std::process::id())),
        );
    }
    v.write("note.md", b"saved").unwrap();
    assert_eq!(v.read("note.md").unwrap(), b"saved");
    assert_eq!(fs::read(&outside).unwrap(), b"keep me");
    let _ = fs::remove_file(&outside);
}

/// Plan 4.4: an edit made by another program shows up in the next snapshot
/// (the desktop app polls it about once a second, so within 2 s).
#[test]
fn snapshot_sees_external_edits_renames_and_deletes() {
    let (t, v) = vault();
    v.write("notes/a.md", b"one").unwrap();
    v.write("b.md", b"b").unwrap();
    let before = v.snapshot().unwrap();
    assert_eq!(
        before.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
        vec!["b.md", "notes/a.md"]
    );

    // Another program (Obsidian, an editor) writes, renames and deletes.
    std::thread::sleep(std::time::Duration::from_millis(15));
    fs::write(t.0.join("notes/a.md"), b"one, edited elsewhere").unwrap();
    fs::rename(t.0.join("b.md"), t.0.join("c.md")).unwrap();
    fs::write(t.0.join("פתק חדש.md"), "שלום".as_bytes()).unwrap();
    let after = v.snapshot().unwrap();
    let a_before = before.iter().find(|e| e.path == "notes/a.md").unwrap();
    let a_after = after.iter().find(|e| e.path == "notes/a.md").unwrap();
    assert!(a_after.size != a_before.size || a_after.mtime != a_before.mtime);
    assert!(after.iter().any(|e| e.path == "c.md"));
    assert!(!after.iter().any(|e| e.path == "b.md"));
    assert!(after.iter().any(|e| e.path == "פתק חדש.md"));
    // Renamed files keep size and mtime: the app pairs them as a rename.
    let b = before.iter().find(|e| e.path == "b.md").unwrap();
    let c = after.iter().find(|e| e.path == "c.md").unwrap();
    assert_eq!((b.size, b.mtime), (c.size, c.mtime));
}

#[test]
fn snapshot_skips_temporary_files() {
    let (t, v) = vault();
    v.write("a.md", b"a").unwrap();
    fs::write(t.0.join(".lumen-tmp-1-1"), b"half").unwrap();
    assert_eq!(v.snapshot().unwrap().len(), 1);
}
