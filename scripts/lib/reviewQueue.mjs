/**
 * The weekly sensitive-review queue (plan W6.13): up to five open pull
 * requests that touch a sensitive path (.github/CODEOWNERS) and still need a
 * person's review, each with what a reviewer needs to start at once — the
 * sensitive files by area, the questions for that area, the tests that
 * already cover those files, and attack cases to try.
 *
 * Pure: scripts/review-queue.mjs fetches the pull requests (gh api, REST)
 * and the test index (the local checkout), then calls buildQueue().
 */
import { codeownersSections, humanReviewVerdict, independentPatterns, sensitiveChanges, HUMAN_REVIEW_LABEL } from "./humanReview.mjs";

/** Per CODEOWNERS section (by its title's first word): weight, the reviewer's questions, attack cases. */
export const AREAS = [
  {
    key: "Cryptography",
    weight: 5,
    ask: "Only WebCrypto or platform primitives? A fresh random nonce/IV per encryption? KDF cost not lowered? Keys never logged, sent or stored in plain text? The authentication tag checked before any plaintext is used?",
    attacks: [
      "Encrypt the same plaintext twice with one key: the two ciphertexts (and nonces) must differ.",
      "Flip one byte of the ciphertext, the nonce and the tag in turn: each decrypt must reject, with no partial plaintext.",
      "Decrypt with a wrong key or passphrase: rejected, and the error says nothing about the plaintext.",
      "Search the diff for the KDF's iteration/memory/time cost and compare it with the base.",
      "Grep the diff for console.* / fetch / localStorage near key material.",
    ],
  },
  {
    key: "Vault",
    weight: 4,
    ask: "Every path kept inside the vault (.., absolute paths, symlinks)? Writes atomic (temporary file + rename)? A failed write leaves the old note intact?",
    attacks: [
      "Write a note named `../outside.md`, `/etc/x.md`, `C:\\x.md` and `a/../../x.md`: each refused, nothing written outside.",
      "A symlink inside the vault pointing outside: reads and writes through it refused.",
      "Kill the write half-way (throw after the temporary file): the old note is unchanged.",
    ],
  },
  {
    key: "Privacy",
    weight: 4,
    ask: "Can a new host, category or rule let note text, keys or personal data leave the device without a user action? Is the default still local-only?",
    attacks: [
      "List every new URL or host in the diff; each must be in src/ai/privacyLedger.ts with its trigger.",
      "With the policy on local-only, run the changed feature: 0 requests (airplane-mode monitor or the network tab).",
    ],
  },
  {
    key: "CSP",
    weight: 3,
    ask: "No new wildcard, 'unsafe-*' or third-party host without a ledger entry? COOP/COEP unchanged unless intended?",
    attacks: ["Run `npm run headers -- --check` and diff the rendered policy against the base's.", "Inject `<script>` and an inline `onerror` in a note: the CSP blocks both."],
  },
  {
    key: "Sanitising",
    weight: 3,
    ask: "Untrusted HTML still sanitised? The plugin iframe still without allow-same-origin?",
    attacks: ["Render `<img src=x onerror=alert(1)>`, `<a href=\"javascript:alert(1)\">`, `<svg><script>alert(1)</script></svg>` and `<iframe srcdoc>`: none runs."],
  },
  {
    key: "Relays",
    weight: 3,
    ask: "The server or relay only ever holds encrypted data? Room tokens and proofs checked before anything is stored or forwarded? Redaction applied before every export door?",
    attacks: ["Send a message with a forged or replayed room token: refused.", "Export a note with a redacted span through every changed door: the span is absent from the output bytes."],
  },
  {
    key: "Every",
    weight: 2,
    ask: "Does every export door call prepareForExport, so redaction and locked notes hold?",
    attacks: ["Export a note with a redacted span and a locked note through the changed door: neither leaks."],
  },
  {
    key: "What",
    weight: 2,
    ask: "Does the preview still parse exactly as redaction reads it?",
    attacks: ["A CriticMarkup span split across lines and nested in code: redaction and preview agree."],
  },
  {
    key: "Frame",
    weight: 3,
    ask: "Every frame still sandboxed, and the frame guard still installed before any content?",
    attacks: ["Inside each changed frame: `top.location`, `parent.document` and `window.open` are blocked."],
  },
  {
    key: "Review",
    weight: 3,
    ask: "Does every redaction pass still read the same input (suggesting marks included), does the preview still parse as redaction does, and is every frame and sink still sandboxed behind Trusted Types?",
    attacks: [
      "A redacted span inside a suggestion and inside an embedded note: absent from the preview's export and from every export door.",
      "In each changed runner or plugin frame: `parent.document` and `top.location` are blocked, and a string assigned to innerHTML is refused by Trusted Types.",
      "Diff index.html's frame-src against EMBED_ORIGINS: equal.",
    ],
  },
  {
    key: "Found",
    weight: 3,
    ask: "What made the gate call this file sensitive (crypto, a network call, an export door, a sanitizer, CSP, a frame, redaction)? Does the change keep that rule's guarantee?",
    attacks: [
      "Run `npm run codeowners:check`: the file's rules, then the matching area's attack cases above.",
      "A new network call: it names a ledger host or carries its `// privacy-ledger:` note (ledgerGaps).",
    ],
  },
  {
    key: "Native",
    weight: 3,
    ask: "No broader fs:/shell: permission? Updates still signed and from the release host only?",
    attacks: ["Diff src-tauri/capabilities/ against the base: every new permission named and scoped.", "An update with a bad signature: refused."],
  },
  {
    key: "This",
    weight: 5,
    ask: "Does the change weaken who must review what (a pattern removed, a rule relaxed)?",
    attacks: ["Diff .github/CODEOWNERS and scripts/lib/humanReview.mjs against the base: nothing sensitive dropped."],
  },
];

const areaOf = (section) => AREAS.find((a) => section.startsWith(a.key)) ?? { key: section || "Other", weight: 1, ask: "", attacks: [] };

const DAY = 86_400_000;

/**
 * prs: [{ number, title, author, base, draft, createdAt, labels, events, reviews, headSha, headDate, files: [{ filename, additions, deletions }] }]
 * codeowners: the CODEOWNERS text; tests: { "<module path, no extension>": ["src/__tests__/x.test.ts", …] }; now: ms; owner: login.
 * → { items, skipped, markdown }
 */
export function buildQueue({ prs, codeowners, tests = {}, now = Date.now(), limit = 5, owner = null }) {
  const sections = codeownersSections(codeowners);
  const independent = independentPatterns(codeowners);
  const items = [];
  let reviewed = 0;
  for (const pr of prs) {
    const files = pr.files ?? [];
    const sensitive = sensitiveChanges(files.map((f) => f.filename), sections);
    if (!sensitive.length) continue;
    const verdict = humanReviewVerdict(sensitive, pr, HUMAN_REVIEW_LABEL, { independent, owner });
    if (verdict.status === "ok") {
      reviewed++;
      continue;
    }
    const byArea = new Map();
    for (const s of sensitive) {
      const sec = sections.filter((e) => e.pattern === s.pattern).pop()?.section ?? "";
      const area = areaOf(sec);
      const f = files.find((x) => x.filename === s.file);
      const cur = byArea.get(area.key) ?? { area, title: sec || area.key, files: [] };
      cur.files.push({ file: s.file, additions: f?.additions ?? 0, deletions: f?.deletions ?? 0 });
      byArea.set(area.key, cur);
    }
    const ageDays = Math.max(0, Math.floor((now - Date.parse(pr.createdAt ?? new Date(now).toISOString())) / DAY));
    const weight = Math.max(...[...byArea.values()].map((a) => a.area.weight));
    const lines = [...byArea.values()].reduce((n, a) => n + a.files.reduce((m, f) => m + f.additions + f.deletions, 0), 0);
    const covering = new Set();
    for (const s of sensitive) {
      const mod = s.file.replace(/\.(tsx?|mjs|js)$/, "");
      for (const t of [...(tests[mod] ?? []), ...(tests[mod.replace(/\/index$/, "")] ?? [])]) covering.add(t);
    }
    // Priority: the riskiest area first, then the oldest, then the larger sensitive diff.
    const score = weight * 100 + Math.min(ageDays, 60) + Math.min(lines, 2000) / 100;
    items.push({ pr, areas: [...byArea.values()].sort((a, b) => b.area.weight - a.area.weight), ageDays, lines, score, tests: [...covering].sort(), why: verdict.lines[0] ?? "", crypto: sensitive.some((s) => independent.has(s.pattern)) });
  }
  items.sort((a, b) => b.score - a.score || a.pr.number - b.pr.number);
  const picked = items.slice(0, limit);
  return { items: picked, waiting: items.length, reviewed, markdown: render(picked, items.length, reviewed, now) };
}

function render(items, waiting, reviewed, now) {
  const date = new Date(now).toISOString().slice(0, 10);
  const out = [`# Sensitive review queue — week of ${date}`, "", `${waiting} open pull request${waiting === 1 ? "" : "s"} touch a sensitive path and wait for a person; ${reviewed} already reviewed after their last commit. The ${items.length} below come first (riskiest area, then oldest).`, "", "Review one: read the diff with the questions, run the tests and the attack cases, approve it in GitHub, then add the label (`gh api -X POST repos/talstilkol/lumen-md/issues/<n>/labels -f \"labels[]=human-reviewed\"`). Cryptography: the label must come from someone other than the owner and the author.", ""];
  if (!items.length) out.push("Nothing waits.", "");
  items.forEach((it, i) => {
    const { pr } = it;
    out.push(`## ${i + 1}. #${pr.number} ${pr.title}`, "");
    out.push(`- Author @${pr.author}, base \`${pr.base}\`, open ${it.ageDays} day${it.ageDays === 1 ? "" : "s"}${pr.draft ? ", draft" : ""}; ${it.lines} changed line${it.lines === 1 ? "" : "s"} in sensitive files${it.crypto ? "; **cryptography: an independent reviewer**" : ""}.`);
    out.push(`- Why it is here: ${it.why}`);
    out.push(`- Link: https://github.com/talstilkol/lumen-md/pull/${pr.number}/files`, "");
    for (const a of it.areas) {
      out.push(`### ${a.title}`, "", ...a.files.map((f) => `- \`${f.file}\` (+${f.additions} −${f.deletions})`), "");
      if (a.area.ask) out.push(`**Ask:** ${a.area.ask}`, "");
      if (a.area.attacks.length) out.push("**Attack cases:**", "", ...a.area.attacks.map((x) => `- [ ] ${x}`), "");
    }
    out.push("**Run:**", "", "```sh", `gh pr checkout ${pr.number}   # or: git fetch origin pull/${pr.number}/head && git checkout FETCH_HEAD`);
    // The tests that import the changed modules most directly come first; a long list is cut at 12.
    if (it.tests.length) out.push(`npx vitest run ${it.tests.slice(0, 12).join(" ")}${it.tests.length > 12 ? `   # and ${it.tests.length - 12} more that import these modules` : ""}`);
    out.push(`npm run pr:check -- --base origin/${pr.base} --pr ${pr.number} --no-size`, "```", "");
    if (!it.tests.length) out.push("No test in src/__tests__ names these modules: writing one of the attack cases above as a test is part of the review.", "");
  });
  return out.join("\n");
}
