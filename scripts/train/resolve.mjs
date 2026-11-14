#!/usr/bin/env node
/**
 * Resolve the merge conflict in progress in the current checkout (plan
 * W6.42; the train's resolver, promoted from lanes T/T2). Run by
 * `npm run train:build` after a merge stops; it can also run by hand.
 *
 *   node scripts/train/resolve.mjs
 *
 * For each unmerged file, in order:
 *   i18n/keys.json            regenerated from the merged sources at the end
 *   theirs already in ours    ours (`contained`)
 *   eval/baseline/*           theirs (a fresh baseline)
 *   *.json                    3-way merge per key
 *   text, additions only      ours + theirs, joints chosen so the file parses
 *   text, shared lines        theirs' hunks ported onto ours (scripts/train/port.mjs),
 *                             also into a file ours moved the code to
 *   anything else             MANUAL: left with diff3 markers for a person
 *
 * Prints one line per file ("union f", "json f", "ported f", "MANUAL f: …")
 * and exits 0 when every file is resolved and staged, 1 when a person is needed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contained, mergeJsonText, parseDiff3, searchUnion, simplifyHunks } from "./lib.mjs";
import { portFile } from "./port.mjs";
import { firstErrorLine, isCode, loadTs, syntaxErrors } from "./ts.mjs";

const gitIn = (cwd) => (...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

/** `git merge-file -p --diff3` of three texts → the marked text. */
export function diff3(ours, base, theirs) {
  const dir = mkdtempSync(join(tmpdir(), "lumen-train-"));
  try {
    writeFileSync(join(dir, "o"), ours);
    writeFileSync(join(dir, "b"), base);
    writeFileSync(join(dir, "t"), theirs);
    try {
      return execFileSync("git", ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", join(dir, "o"), join(dir, "b"), join(dir, "t")], { encoding: "utf8", maxBuffer: 1 << 28 });
    } catch (e) {
      return e.stdout; // why: merge-file exits with the number of conflicts; the output is what we want
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolve every unmerged file in `cwd` → { ok, lines }. */
export function resolveConflicts(cwd = process.cwd(), ts = loadTs(process.env, cwd)) {
  const git = gitIn(cwd);
  const stage = (n, f) => {
    try {
      return git("show", `:${n}:${f}`);
    } catch {
      return null; // why: the file has no such stage (added or deleted on one side)
    }
  };
  const write = (f, text) => writeFileSync(join(cwd, f), text);
  const files = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  const lines = [];
  let ok = true;
  const manual = (f, why, text) => {
    if (text != null) write(f, text);
    lines.push(`MANUAL ${f}: ${why}`);
    ok = false;
  };
  for (const f of files) {
    const b = stage(1, f) ?? "";
    const o = stage(2, f);
    const t = stage(3, f);
    if (f === "i18n/keys.json") {
      write(f, t ?? o ?? "");
      continue;
    }
    if (o === null || t === null) {
      manual(f, `${o === null ? "deleted by ours" : "deleted by theirs"}, changed by the other side`);
      continue;
    }
    if (!f.endsWith(".json") && contained(b, o, t)) {
      write(f, o);
      git("add", "--", f);
      lines.push(`contained ${f} (ours already has theirs' change)`);
      continue;
    }
    if (f.startsWith("eval/baseline/")) {
      write(f, t);
      git("add", "--", f);
      lines.push(`theirs ${f}`);
      continue;
    }
    if (f.endsWith(".json")) {
      try {
        let baseText = b;
        try {
          JSON.parse(b || "{}");
        } catch {
          // A criss-cross's virtual base holds markers: use a real merge base's version.
          baseText = "";
          for (const mb of git("merge-base", "--all", "HEAD", "MERGE_HEAD").split("\n").filter(Boolean)) {
            try {
              baseText = git("show", `${mb}:${f}`);
              JSON.parse(baseText);
              break;
            } catch {
              baseText = ""; // why: not in that merge base, or not JSON there; try the next
            }
          }
        }
        const m = mergeJsonText(baseText, o, t);
        write(f, m.text);
        git("add", "--", f);
        lines.push(`json ${f}${m.problems.length ? ` NOTE ${m.problems.join("; ")}` : ""}`);
        if (m.problems.some((p) => p.includes("deleted"))) ok = false;
      } catch (e) {
        manual(f, e.message);
      }
      continue;
    }
    const marked = diff3(o, b, t);
    const segs = parseDiff3(marked);
    const pureAdd = simplifyHunks(segs);
    const code = isCode(f);
    if (!pureAdd && !f.endsWith(".gitignore")) {
      // Port without staging: only a port that parses is staged.
      const p = portFile(cwd, f, { base: b, ours: o, theirs: t }, { stage: false });
      if (!p.left.length) {
        const bad = code && ts ? p.touched.filter(isCode).flatMap((x) => syntaxErrors(ts, x, readFileSync(join(cwd, x), "utf8"))) : [];
        if (!bad.length && (!code || ts)) {
          for (const x of p.touched) git("add", "--", x);
          lines.push(`ported ${f}${p.moved.length ? ` → ${p.moved.join(", ")}` : ""}`);
          continue;
        }
        lines.push(code && !ts ? `port of ${f} not syntax-checked (no TypeScript)` : `port broke syntax: ${bad.join(" | ")}`);
        // Undo what the port wrote in other files; the conflicted file gets its markers back below.
        for (const x of p.touched) if (x !== f) git("checkout", "HEAD", "--", x);
      } else lines.push(`port ${f}: ${p.left.join("; ")}`);
      manual(f, `${segs.filter((x) => !Array.isArray(x)).length} hunks change shared lines`, marked);
      continue;
    }
    if (code && !ts) {
      manual(f, "a code union needs the TypeScript parser (node_modules, or LUMEN_TS)", marked);
      continue;
    }
    const u = searchUnion(segs, { isCode: code, valid: (text) => !code || !syntaxErrors(ts, f, text).length, firstErrorLine: code ? (text) => firstErrorLine(ts, f, text) : null });
    if (!u) {
      manual(f, `${segs.filter((x) => !Array.isArray(x)).length} hunks, no union that parses`, marked);
      continue;
    }
    write(f, u.text);
    git("add", "--", f);
    lines.push(`union ${f}${u.choice.some(([a, c]) => a || c) ? ` joint ${JSON.stringify(u.choice)}` : ""}`);
  }
  if (ok && files.some((f) => f.startsWith("i18n/") || f.startsWith("src/i18n/"))) {
    // The generated i18n files follow the merged sources.
    for (const s of ["scripts/i18n-split.mjs", "scripts/extract-i18n-keys.mjs"]) {
      try {
        execFileSync(process.execPath, [s], { cwd, stdio: "ignore" });
      } catch {
        // why: extract-i18n-keys exits 1 on drift after writing the file; the train's i18n:check reports it
      }
    }
    try {
      git("add", "-A", "--", "i18n", ":(glob)src/i18n/locales/*/*.json");
    } catch {
      // why: the pathspec matches nothing on a tree without per-domain locales
    }
    lines.push("i18n regenerated");
  }
  return { ok, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = resolveConflicts();
  console.log(r.lines.join("\n"));
  process.exit(r.ok ? 0 : 1);
}
