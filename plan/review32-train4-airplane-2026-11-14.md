# Security review 32 (14.11): train 4's airplane mode after the RR20-1 hand-port

**Reviewer.** RR32, an independent agent. I am also the reviewer of rounds 11 to 30, which covered #451 and #589. I wrote none of this code.

**Access.** Read-only.
- I did not touch `/home/claude/w-train4`. It has moved on to `c6a7aa00b8` (#574 merged after the target), so I made my own detached worktrees:
  - `/home/claude/w-rr32-t4` at the target `60e130989032f1c047025c6b507aa3adfd7a5fa1`;
  - `/home/claude/w-rr32-t4tip` at `c6a7aa00b85027acda5b154820bcf2a82f8ebec1`, the tip, for a second run.
- I pushed, commented and merged nothing.

**Files.** `S=/tmp/claude-0/-home-claude/db859785-2ec7-51e3-b6ba-0edfee54cc7b/scratchpad`. Tests and outputs are in `$S/rr32/t/`.

**Harness change.** In my copies of the three Chromium harnesses (rr18's X, R6's W+O, rr6's E), I added an esbuild stub plugin and the zustand/idb aliases.
- They are needed because `airplane.ts` now imports `privacyLedger.ts`, which pulls in the app's module graph.
- The test cases themselves are unchanged.

**Convention.** A FAIL means the attack worked. Every outside host in the Chromium tests is answered by Playwright's router, so nothing left this machine.

## Verdict: the port is faithful, nothing from rounds 6–18 was lost, and P1/P2 pass

## 1. The port is faithful to #589

- **airplane.ts against #451's head.** At the target, `src/privacy/airplane.ts` differs from #451's current head (`aae88fe95a`) **only** by the port (train commit `98f7487dfa`):
  - one import of `wrapLedgerTransport`;
  - the fetch wrapper turned into `guard(inner)`;
  - `win.fetch = guard(win.fetch.bind(win))`;
  - `wrapLedgerTransport(guard)`, called for the real window only.
- **The guard against #589's.** Whitespace-normalised, the guard block (from `const guard = (innerFetch` to `wrapLedgerTransport(guard);`) is **byte-for-byte identical** to #589's, at both its current head `a2f9241f` and the reviewed `2a653aba80`.
- **`wrapLedgerTransport`.** In `privacyLedger.ts` it is identical to #589's. It wraps both `unwrappedFetch` (used by `ledgerFetch`) and `rawFetch` (used by `guardedFetch`).
- **The rest of `src/privacy/`.** `airplaneBoot.ts` and `airplaneCertificate.ts` are identical to #451's head. `NetworkMonitor.tsx` differs only by train-wide UI changes (design tokens, a help button, a ledger comment). It still seals the certificate with `egressTally()`.

## 2. Nothing from rounds 6–18 was lost

| suite | at 60e1309890 | at the tip c6a7aa00b8 |
|-------|---------------|------------------------|
| X1–X7 (rr11/18) | X1–X5 and X7 pass; X6 fails, **as disclosed** (closed declarative shadow root, latent) | same |
| W1–W10 (rr8) | 10/10 | 10/10 |
| O1–O7 (switch on) | 7/7 | 7/7 |
| E1–E9 (rr6) | E1–E6, E8, E9 pass; E7 fails, **the stated tradeoff** (a popup is counted, not closed) | E1 failed once (2 requests after the switch), then passed 3/3 on rerun at both heads: a timing flake at the harness's 100 ms boundary. Otherwise the same. |
| R1 / R2 (rr8's functional checks) | EmbedBlock's provider link opens its window again with the switch off; a www.youtube.com frame keeps its storage | — |
| Certificate /3 (`t/cert3.mjs`) | **pass**: an in-flight record followed by 600 CSP refusals stays in the list (501 listed); the summary counts `attempts 601`, `left 1`, `dropped 100` | pass |
| The train's `airplane.test.ts` (vt3m) | 28/29 (the shim's known `<meta>` gap) | — |
| The train's `airplaneLedger.test.ts` (Chromium) | 1/1 | — |
| The train's `privacyLedger.test.ts` | 15/15 | — |

**EMBED_ORIGINS on the train.** The train changes the frame model:
- The app's own `frame-src` is `'self'` only.
- Embeds render inside `/content-frame.html` (W4.15), whose policy lists the 19 providers in `frame-src` and Gist in `script-src`.
- So my rr11 `r451-origins.mjs`, which compares with the first `frame-src`, no longer applies.
- The train's `airplane.test.ts` keeps the new rule: EMBED_ORIGINS equals the https origins of the content frame's `frame-src` plus `script-src`, and it passes.
- `headers --check` passes.
- The embed content frame keeps `allow-popups` (`contentFrame.ts:45`), and the guard strips it while the switch is on, as before.

**Not covered by these suites:** the X, W and O cases put provider frames directly in the app's document. On the train a real embed sits one level down, inside the same-origin content frame.
- From reading, the observer guards same-origin frames' documents, and `popupFrames` recurses into them, so the nesting should be covered.
- I did not run a content-frame-specific case.

## 3. P1 and P2 on the train

`t/airplane.mjs` (rr20/25's harness: the real ledger plus airplane, in `main.tsx`'s order, using the gated fetch):

| test | at 60e1309890 | at the tip |
|------|---------------|------------|
| **P1:** switch on, 7 requests to the new hosts | 0 reach a host (`AirplaneBlockedError`) | same |
| **P2:** a request in flight at the switch | **counted `in-flight` and aborted** | same |

## Note

#574 (merged after the target) moves `EMBED_ORIGINS`, `egressTarget` and `guardedSandbox` into `src/privacy/airplaneEmbeds.ts`. The suites above pass at that tip too. That move itself is not part of this review.

**Domain rule.** The taken domain appears nowhere in these files.

---

## Addendum: an embed inside `/content-frame.html` (the gap section 2 noted)

**Where:** train 4's tip `c6a7aa00b8`, in my own read-only worktree `/home/claude/w-rr32-t4tip`.

**Harness:** `$S/rr32/t/cf.mjs`, output in `cf.out`, two repeat runs in `cf-repeat.out`.
- **App page.** The worktree's real `installAirplaneMode` and `enableAirplaneMode`, plus its `contentFrameSrc` and `contentFrameSandbox`.
  - The app makes the embed the way the train does: an iframe with `contentFrameSandbox("embed")` on `/content-frame.html#{"kind":"embed",…}`.
- **Content frame.** The worktree's own `public/content-frame.html` and `content-frame.js`.
  - The page builds the provider frame itself, inside the content frame, with `allow-popups`.
- **Policies.** Each page is served with its policy from `public/_headers`: the app gets its two CSP headers, and the content frame gets its own.
- **Provider.** `https://www.youtube-nocookie.com` (one of the content frame's `frame-src` providers) is answered by Playwright's router. The site the popup opens is a local server, so nothing left this machine.
- **Measuring.** Requests count as after the switch from 150 ms after it.

| case | result |
|------|--------|
| **CF1 (P1-style):** the provider page pings its origin every 200 ms | **pass**: 7 pings before, **0 after** the switch |
| **CF2 (X1-style):** the provider opens a window, then the embed is unmounted before the switch | **pass**: the window keeps loading (it is counted, not closed, as stated), and the certificate records `POPUP in-flight …/content-frame.html` |
| **CF3 (X2-style):** the provider opens a window, and the embed stays | **pass**: `POPUP` is recorded for both the provider frame and the content frame |
| **CF4 (P2-style):** the provider page's request is in flight at the switch (answered 3 s later), then fetches `/done` | **pass**: the request reached the provider before the switch, the switch blanked the frame, and `/done` never came |

The two repeat runs gave 4/4 both times.

**Why the nesting holds:**
- At the switch, `popupFrames` reaches into the same-origin content frame and counts the provider frame by its own `allow-popups`, shown as the `…/embed/abc` record in CF1, CF3 and CF4.
- The latch on the content frame itself (it has `allow-popups`) covers the case where the embed is gone (CF2).
- `blankFrames` empties the content frame, and with it every request of the provider frame inside.

**Note on the agent proxy.** During these Chromium runs the agent proxy reported refused connections to accounts.google.com, www.google.com and android.clients.google.com. That is Playwright's Chromium making its own background requests at startup, not the app or the test: every host the test uses is answered by the router or by a local server. It also explains the accounts.google.com refusal noted in review 20.
