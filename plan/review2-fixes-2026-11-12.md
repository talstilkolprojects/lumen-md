# Security review 2 (12.11): lane R's fixes for review 12.11

**Reviewer.** RR2, an independent agent. I did not write the original PRs or lane R's fixes.

**Access.** Read-only. I pushed, commented, merged and closed nothing.

**Worktrees.** `/home/claude/w-rr2-<pr>`, detached at each PR's current head. I checked again at the end that these are still the heads on GitHub:

| PR | head |
|----|------|
| #473 | `d84230e0c086ffe7180ffeeb3ff0f63f4a4c7256` |
| #451 | `81728f474b0d77df9aa96fb198c901d92b109b7b` |
| #483 | `aa47bbb20f6d966a56874ceb0b298b941cdd1fc6` |
| #488 | `b3b2e79d2115a1e5fcfe9348572d40bf81e70fae` |
| #461 | `ceee062e5b9efa1bc09594e804b49ff8fc377ff3` |
| #448 | `277d08ab3f0dce23c8dc8f979927c229102a21dc` |
| #469 | `10820cc1bb1f54acd1d1cd8b77e3a78a1c75447d` |

**Tests.** All of them are in `/tmp/claude-0/-home-claude/db859785-2ec7-51e3-b6ba-0edfee54cc7b/scratchpad/rr2/`:
- `orig/`: copies of the 12.11 failing tests, pointed at the new worktrees;
- `r483-relay.orig.test.mjs`: the relay test, with the relay path given by `$RELAY`;
- the new attack tests, alongside;
- `receipts/`: one `lumen-review` v1 receipt per PR.

**How to run them.**
- `.test.ts`: `cd /home/claude/w-rr2-<pr> && node --no-warnings --experimental-transform-types --import $S/E/vt3/register.mjs $S/E/vt3/runner.mjs <abs test path>`
- `.mjs`: plain `node`. The relay tests take `RELAY=/home/claude/w-rr2-<pr>/sync-server/vault-relay.js`.

**Convention.** Each attack test asserts the **safe** behaviour, so a FAIL is a confirmed defect.

## Summary

| PR | Original findings | Verdict on the fixes | New findings | Receipt |
|----|-------------------|----------------------|--------------|---------|
| #473 | 3 high, 4 med, 13 low, 14 low | #3 fixed; #13 fixed; #14 fixed; **#4 partially** | 1 medium, 3 low | changes-requested |
| #451 | 5 med, 6 med, 7 med | #5 **partially**; #6 **partially**; #7 fixed | 2 medium | changes-requested |
| #483 | 8 med, 9 med | #8 **partially**; #9 fixed | 4 medium, 1 low, 1 info | changes-requested |
| #488 | (inherits #483) | merge correct; inherits all of #483's findings | (same as #483) | changes-requested |
| #461 | 11 med | **fixed** | none | approve |
| #448 | 12 med (seam), 16 low | #12 fixed (once #473 lands; verified on a scratch merge); #16 **partially** | 3 low | approve |
| #469 | 15 low | **partially** (the "authenticated" gate is free on the public relay) | 1 medium | changes-requested |

**Nothing is critical or high.** The main themes are:
- **Concurrency and address-model evasion of the new relay quotas.** Bursts, IPv6, a reverse proxy, and tiny objects all get past them.
- **Fail-open paths that remain in photo cleaning.** The cleaner trusts the declared type and the file extension.
- **Airplane-mode workers trust any same-origin tab.** Runner frames that are already running keep sending.
- **The collab token is free.** On the public relay, the "authenticated change" gate costs one request.

---

## #473 (journalist mode): fix d84230e0c

### Original findings

- **#3 HIGH, Publish site bypasses redaction: FIXED.**
  - `src/publish/site.ts:291` runs `prepareForExport` on every note before its page, title and search index are made.
  - Assets are cleaned with `cleanImageBytes`, or withheld.
  - Test: `orig/r473-publish-site.test.ts` 1/1 (0/1 before). `publishSite.test.ts` 10/10, `redaction.test.ts` 14/14.
- **#14 LOW, CLI does not redact: FIXED.**
  - `src/cli/convert.ts` (`prepareForExportSync` and `prepareForExport`) and `src/cli/publish.ts:401` now redact.
  - Without a canvas in Node, an unparseable photo is skipped.
- **#13 LOW, the sealer trusts the magic line: FIXED for an open note.**
  - It re-seals unless the text is exactly an envelope that opens with the note's own key (`lockedNote.ts:173-190`).
  - Test: `orig/r473-sealer-magic.test.ts` 1/1; `lockedNote.test.ts` 7/7.
  - A residual case is below (RR2-473-4).
- **#4 MEDIUM, EXIF stripping fails open: PARTIALLY FIXED.**
  - Fixed:
    - a stray byte, and data after EOI, IEND or the RIFF size: `orig/r473-exif.test.ts` 2/2, `imageMetadata.test.ts` 9/9;
    - a parse error is now an `ImageMetadataError`, then a canvas re-encode, then a refusal.
  - Not fixed: the cleaner keeps bytes it does not recognise, and it decides what to clean from the declared type or the extension, not from the content. See RR2-473-1 and RR2-473-2.

Other checks with no defect:
- Every export door I found calls `exportReadyText`: HTML, PDF/print, DOCX, every export command, `publishNote`, the CLI and the site.
- Embeds are not expanded on export.
- Every image-insert path goes through `handleAssetFiles` → `cleanImageFile`. A cleaner chunk that fails to load drops the photos instead of passing them through.

### New findings

**RR2-473-1 (MEDIUM, confirmed): a photo whose bytes don't match its declared type is kept unchanged, GPS included.**
- **Where:**
  - `src/lib/imageMetadata.ts:247-253`: `stripImageMetadata` returns `format: null` and the original bytes when no JPEG, PNG or WebP magic matches, even when the caller declared `image/jpeg`, `image/png` or `image/webp`.
  - Callers then pass that through:
    - `cleanImageFile` (`imageMetadata.ts:345`, `if (!r.format …) return file`);
    - `cleanInlineImages` (`src/lib/redaction.ts:223`) and `cleanInlineImagesAsync` (`redaction.ts:253`);
    - Publish site (`src/publish/site.ts:338-339`: `r.type === type` holds, because a null format echoes the declared type).
- **Scenario:**
  1. A HEIC or AVIF photo (an iPhone original, or a converter's output) is saved or shared with a `.jpg` name, so the browser reports `image/jpeg`.
  2. The editor stores it unchanged.
  3. Every export (`data:image/jpeg;base64,…`) and Publish site ship its EXIF and GPS. Safari, and Chromium for AVIF, sniff the content and display it, so the user sees a normal photo.
- **Test:** `rr2/r473-failopen2.test.ts` F1 (cleanImageFile), F2 (async and sync export doors), F3 (Publish site). All three FAIL.
- **Fix:** When the declared type (or the extension) is JPEG, PNG or WebP and no parser recognises the bytes, throw `ImageMetadataError`. That leads to a re-encode, or to a refusal. In the inline and site paths, treat `format: null` as "withhold" unless the bytes are a known metadata-free format (GIF, SVG).

**RR2-473-2 (LOW, confirmed): Publish site and `lumen publish` copy photos with other extensions verbatim.**
- **Where:** `src/publish/site.ts:277,334` (`IMAGE_TYPE` = jpg/jpeg/png/webp; anything else is `assets.set(ref, data)`) and `src/cli/publish.ts:39,467` (`copyFileSync`).
- **Scenario:**
  - A real JPEG named `.jfif` (Windows' default for many downloads) or `.jpe` keeps its GPS on the public site. The same happens to `.tif`, `.heic` and `.avif`.
  - The CLI also copies every other non-Markdown file in the folder, such as `.mov` or `.mp4` with a location atom.
- **Test:** `rr2/r473-failopen2.test.ts` F4 FAILS (`a.jfif`, `b.jpe` and `c.tif` are published with GPS).
- **Fix:**
  - Sniff the content, not the extension.
  - Clean JPEG, PNG and WebP whatever the extension.
  - Withhold TIFF, HEIC, AVIF and video unless the user keeps metadata, or report them as "not cleaned".

**RR2-473-3 (LOW, confirmed for JPEG; from reading for C2PA): unknown segments and chunks are kept.**
- **Where:** `imageMetadata.ts:106-110` keeps every marker it doesn't list. That includes the reserved JPGn markers `0xF0`–`0xFD`; JPEG-XT and C2PA are APP11 and are removed. PNG keeps every chunk except five, and WebP keeps every chunk except EXIF and XMP. So PNG `caBX` and the WebP `C2PA` chunk (Content Credentials, which can carry location assertions) stay.
- **Test:** `rr2/r473-failopen2.test.ts` F5 FAILS (EXIF/GPS bytes inside an `0xFD` segment survive).
- **Fix:** Use an allow-list instead:
  - JPEG: DQT, DHT, SOFn, SOS, DRI, RSTn, APP0 (JFIF), APP2 (ICC), APP14;
  - PNG: critical chunks plus iCCP, sRGB, gAMA, cHRM, pHYs, sBIT, tRNS, bKGD, acTL, fcTL, fdAT;
  - WebP: VP8, VP8L, VP8X, ALPH, ANIM, ANMF, ICCP.

**RR2-473-4 (LOW, confirmed; behaviour kept from before the fix): a closed locked note can be replaced by any well-formed envelope.**
- **Where:** `src/storage/lockedNote.ts:191`. With no key in memory, `if (isEnvelopeText(content)) return content;` accepts an envelope under **any** password, checked only against `STRUCTURE_ONLY` (a minimum of 1 PBKDF2 iteration). That bypasses `LockedNoteOverwriteError`.
- **Scenario:** A tool, plugin or agent write (or an old tab) puts an envelope sealed under another password over `sources.md`. The real note is gone, with no error. The user's password then fails as "wrong password".
- **Test:** `rr2/r473-failopen2.test.ts` F6 FAILS.
- **Fix:** When the current file is sealed and the note is not open, refuse any write that is not byte-identical to the current envelope (or that does not carry the same KDF salt). Pass a new envelope only through an explicit `allowPlainWrite`-style path, such as "Lock note" or "Change password".

---

## #451 (airplane mode): fix 81728f474

### Original findings

- **#7 MEDIUM, the certificate's "0 left": FIXED.**
  - Format `/2` counts attempts, not bytes.
  - A cross-origin resource has no size and always counts.
  - Requests, sockets and peers still open when the switch goes on are recorded as `in-flight`, then aborted or closed.
  - The certificate states its scope (`counts` / `notCounted`).
  - Test: `airplane.test.ts` 20/21 under the shim, with the same `<meta>`-lookup shim gap as on the PR head.
- **#5 MEDIUM, runner frames escape: PARTIALLY FIXED.**
  - Fixed: a frame created after the switch is refused (`frame-src blob:`), and both blocks pause. Test: `orig/r451-runner-iframe.mjs` PASS in Chromium (0 requests; "Refused to frame … frame-src blob:").
  - Not fixed: a frame that is **already running** when the switch goes on (RR2-451-2).
- **#6 MEDIUM, a worker's fetch fails open: PARTIALLY FIXED.**
  - Fixed: a timeout now blocks (`orig/r451-worker-failopen.test.ts` 1/1), and airplaneBoot answers `hello` from the startup bundle.
  - Not fixed: a worker accepts "off" from any same-origin context (RR2-451-1).

**Ruled out:** "the boot answerer keeps answering *off* after switching on without a reload". `enableAirplaneMode` → `addAirplaneCsp` sets the boot flag (`airplaneBoot.ts:46`). Test: `rr2/r451-boot-stale.test.ts` 2/2 PASS, which shows no defect there.

### New findings

**RR2-451-1 (MEDIUM, confirmed): a worker takes "off" from any tab of the app.**
- **Where:** `src/ai/workerLedger.ts:107-113`. The airplane channel is a same-origin `BroadcastChannel`, so every tab hears it. Every `{kind:"state"}` message sets `airplane = (on !== false)`, the latest message wins, and nothing says which window sent it. Both `airplaneBoot.answerWorkers` and airplane.ts in **every** tab answer every `hello`. Nothing listens for the `storage` event, so a tab loaded before the switch stays "off".
- **Scenario:** The user has two tabs open and turns airplane mode on in tab A. Tab B (still off) answers the `hello` of tab A's model worker with `on:false`, and does so again whenever a worker starts in tab B. Tab A's transformers or WebLLM worker then downloads from huggingface or jsDelivr. The workers' header CSP allows those hosts, and the window's `<meta>` doesn't cover workers.
- **Test:** `rr2/r451-cross-tab.test.ts` FAILS (`sent: ['https://huggingface.co/model.onnx']`). It uses real BroadcastChannels and the real `airplaneBoot`, `airplane` and `workerLedger` modules; tab B is simulated by a channel that answers as its boot does.
- **Fix:**
  - Bind each answer to its own window: give the worker a window id (worker `name`, or a constructor message), and answer only matching hellos.
  - Make "on" sticky in the worker: once it has heard `on:true`, only a reload clears it.
  - Also listen for `storage` events, so other tabs switch on (or reload).

**RR2-451-2 (MEDIUM, confirmed): a runner frame already running when the switch goes on keeps reaching other sites, and isn't counted.**
- **Where:**
  - `src/privacy/airplane.ts:201` (`enableAirplaneMode`) inserts the `<meta>` and aborts the window's own fetch, XHR and sockets. It leaves existing playground and live-js frames alone.
  - A frame keeps its own header policy (`img-src *`).
  - The parent's PerformanceObserver doesn't see frame loads, so the certificate shows nothing. `notCounted` says that "a frame open before it went on is not counted", but the doc comment says "everything is stopped from this moment".
- **Scenario:** A playground preview with a timer or poller (a live chart, a clock, a shared note's "demo") is open. The user turns airplane mode on, and the frame keeps loading `https://x/?d=…`.
- **Test:** `rr2/r451-runner-open-before.mjs` (Playwright Chromium) FAILS. 7 requests from the runner reached the other origin after the switch; the app window's own request was blocked (the control).
- **Fix:** In `enableAirplaneMode`, remove or blank every runner iframe (`iframe[src*="-runner.html"]`, or a registry kept by the two blocks), and terminate live-js workers. Or broadcast a "stop" event the blocks handle by bumping `frameKey` to a paused state. Record each one as `in-flight`.

---

## #483 (vault relay): fix aa47bbb20; #488 merges it unchanged (ecc6bd3f9, b3b2e79d2)

### Original findings

- **#9 MEDIUM, retention counts only writes: FIXED.**
  - An authenticated GET (of an existing object) or list touches the space, at most once a day.
  - Test: `rr2/r483-relay.orig.test.mjs` case (1) PASS on both #483 and #488 (FAIL on the 12.11 base).
  - `syncSetup.test.ts` 19/19 on #483 and #488; `classroom.test.ts` 11/11 on #488.
- **#8 MEDIUM, quota per free token: PARTIALLY FIXED.**
  - The serial case is fixed: case (2) PASS.
  - The new per-address and global caps can be evaded, as RR2-483-1 to RR2-483-4 show.

Other checks with no defect:
- The invite is compared in constant time.
- The PoW is bound to the space id, with a sane nonce charset.
- The 428 retry re-sends the body.
- Append-only (`a.`) tokens are refused before the body is read.
- The drop-box object cap applies to `readBody`.
- The HMAC key for addresses is in memory and rotated daily.
- The docs say a public build's invite is public.

### New findings

**RR2-483-1 (MEDIUM, confirmed): concurrent first writes pass the daily new-space and per-address byte limits.**
- **Where:** `sync-server/vault-relay.js` (#483 line numbers; #488: :364/:375).
  - `:326` checks `q.spaces >= newSpacesPerDay` outside the lock and before the body, but `q.spaces++` happens only after `store.put` (`:342`).
  - `:336` checks `q.bytes` inside the per-*space* lock, but `q.bytes +=` (`:341`) happens after the awaited put, and different spaces don't share a lock.
  - The global cap (`:337`) has the same check-then-act gap.
- **Scenario:** One address sends 50 PUTs to 50 fresh tokens at once, and all 50 spaces open (limit 5). With the disk store, 20 concurrent 90 KB uploads store 1.8 MB against a 100 KB daily cap. At 600 requests a minute, the per-address limits bound nothing.
- **Test:** `rr2/r483-relay-evasion.test.mjs` A1 (50/5) and A2 (1,800,000 > 100,000) FAIL on #483 and #488.
- **Fix:** Reserve before awaiting. Increment `q.spaces` and `q.bytes` (and `total`) synchronously when the request passes the check, and roll back on failure. Or run the quota step under a per-address lock.

**RR2-483-2 (MEDIUM, confirmed): "per address" means per full IPv6 address, and the quota map resets at 100,001 entries.**
- **Where:**
  - `vault-relay.js:205` HMACs the whole `remoteAddress`. A single host has a /64, which is 2^64 addresses.
  - `:210` runs `if (quota.size > 100000) quota.clear()`.
  - `quotaOf` runs for every PUT, even one later refused (no invite, no PoW), so the refused requests themselves fill the map.
- **Scenario:** One IPv6 host opens unlimited spaces. Separately, 100,002 refused PUTs from distinct addresses wipe every address's daily counts, its own included.
- **Test:** A3 (40 spaces from one /64, limit 5) and A4 (the same IPv4 address opens a 6th space after the map is cleared) FAIL.
- **Fix:**
  - Key IPv6 by /64 (or /56), and normalise IPv4-mapped addresses.
  - Create a quota entry only on a successful write.
  - When the map is full, refuse new addresses (fail closed) instead of clearing it. Or use a fixed-size counting sketch.

**RR2-483-3 (MEDIUM, confirmed): mounted behind a proxy, every client is one address, so 5 new vaults a day for the whole relay.**
- **Where:** `vault-relay.js:205` uses `req.socket.remoteAddress`. The documented deployment is `VAULT_RELAY=1 node sync-server/server.js` (`two-clicks.md:53`, `classroom.md:33`). On Fly (`sync-server/fly.toml`, `SIGNAL_TRUST_PROXY=1`), `server.js` already reads `Fly-Client-IP` for its own limits (`server.js:63-71`), but the relay ignores it.
- **Scenario:** The 6th user to set up sync on a given day gets 429 "new spaces today". One attacker who opens 5 spaces, or writes 1 GiB, at 00:00 locks everyone out of the relay for that day. The 600-requests-a-minute limit (from before) is also global behind the proxy.
- **Test:** A5 FAILS: 5 of 6 distinct `Fly-Client-IP` users could open a vault.
- **Fix:** Pass `server.js`'s `clientIp(req)` (trust-proxy aware) into `createVaultRelay` as `opts.clientAddress`, and use it in `addressId`. Document the same for the standalone relay behind nginx (`X-Forwarded-For` with an explicit trust flag).

**RR2-483-4 (MEDIUM, confirmed): the byte caps count logical bytes, but the disk holds blocks and inodes.**
- **Where:** `vault-relay.js`: `store.bytes()` sums file sizes, and private spaces have no object-count cap. The drop box has one (`maxDropCount`); a private space does not.
- **Scenario:** One token writes 2,000 one-byte objects against a 20,000-byte space cap. Each costs a 4 KiB block and an inode, so the disk holds 8.2 MB, 412 times the cap. At the rate limit, that is about 860,000 files a day per address, counted as 860 KB. This exhausts inodes and real disk long before `VAULT_RELAY_MAX_TOTAL`.
- **Test:** A6 FAILS (`du` 8,232,960 bytes for a 20,000-byte cap).
- **Fix:** Charge `max(size, 4096)` per object in every cap. Add a per-space object-count cap (for example 50,000), and a global object cap.

**RR2-483-5 (LOW, from reading): the global cap turns a fill into a lasting denial of service for everyone.**
- RR2-483-1 to RR2-483-4 make filling `VAULT_RELAY_MAX_TOTAL` (20 GiB) cheap. After that, every legitimate write that grows a space gets 507 "relay full".
- Reads now refresh retention (the #9 fix), so the attacker keeps the junk alive with one GET a day per space, indefinitely.
- **Fix:**
  - First fix RR2-483-1 to RR2-483-4.
  - Consider a per-space idle limit that is not refreshed by reads from the address that wrote the space, or evicting the newest spaces first when the relay is full.
  - Alert the operator when the relay is at 80 %.

**RR2-483-6 (LOW, from reading): the total is recounted by every concurrent request at once.**
- `vault-relay.js:217` (`totalNow`): `total ??= await store.totalBytes()` assigns only after the await. After a start or a sweep (`total = null`), every concurrent PUT starts its own full walk of the disk store, and every file gets a `stat` call in each walk.
- `total = (await totalNow()) + delta` after a concurrent sweep double-counts. This errs on the safe side.
- **Fix:** Cache the promise (`totalP ??= store.totalBytes()`), and recount in the background.

**RR2-483-7 (INFO):** The server accepts `VAULT_RELAY_POW_BITS` up to 32, but the app refuses anything above 24 (`MAX_POW_BITS`). An operator who sets 25–32 makes every new vault fail. Clamp the server at 24, or document the limit.

**#488-specific:** The merge resolution is correct:
- append-only is checked before the body;
- the drop-box object cap is in `readBody`;
- the new-space gate also applies to `a.` and `o.` tokens.

The first student submission opens a drop box (`createAssignment` writes nothing to the relay), so it counts against the school's single address. The docs say to raise the limits, which is acceptable. #488 inherits RR2-483-1 to RR2-483-7, and RR2-483-3 hits a school behind one NAT hardest.

---

## #461 (local usage metrics): fix ceee062e5: FIXED, no new findings

- **#11 MEDIUM: FIXED.**
  - `featureId()` folds `template.installed.*`, `recent.*` and `plugin:*` into fixed ids, in both `bump` and `apply`.
  - `weeklyReport` is now a strict allow-list: it reports only fixed ids of current commands, never a raw id stored before the fix, and nothing when it is given no ids.
  - `unusedFeatures` folds the same way.
- **Tests:**
  - `orig/r461-template-name.test.ts` 1/1 (0/1 on the 12.11 base);
  - `usageMetrics.test.ts` 16/16;
  - `rr2/r461-families.test.ts` 5/5: every family, an old raw count, no ids, the unused list, and the storage path.
- **What I checked:**
  - Every dynamic command id in `src/` (grep for template-literal ids):
    - `lang.*`, `template.<builtin>`, `ai.prompt.*` and `emoji.*` come from built-in lists;
    - sandboxed plugins are `plugin:<id>:<cmd>` (folded);
    - built-in plugins register static ids.
  - The `privacyLedger.ts` addition (`recordUserShare`) records only the host and the size.

## #448 (share link): fix 277d08ab3: approve, with low findings

- **#12 MEDIUM, the seam with #473: FIXED once both are in the build.**
  - `rr2/r448-seam.test.ts` passes on a scratch tree: #448's `src` plus #473's `exportReady.ts`, `redaction.ts` and `imageMetadata.ts`. The `<redact>` passage, the HTML comment and the `%%` comment are all gone.
  - On #448 alone, the door is absent and the text passes through (the documented fallback).
- **#16 LOW: PARTIALLY FIXED.**
  - Origin: Tauri, Capacitor, localhost, RFC 1918 and non-https pages now fall back to the public app.
  - Inflation: a cap exists (`rr2/r448-share.test.ts` S1 PASS: an 8 KB crafted link is refused), but it is relative (below).
  - `linkShare.test.ts` 12/12.

### New findings

**RR2-448-1 (LOW, confirmed): the inflation bound has no absolute ceiling.**
- **Where:** `src/share/linkShare.ts:53`, `maxInflated = max(32 KiB, compressed) × 100`. `SharedNoteView.tsx:163` reads a `.lumenshare` file of any size.
- **Scenario:** A 20 MB crafted file may inflate to 2.1 GB, held in memory before the cancel, which crashes the viewer tab. This is a viewer-only denial of service.
- **Test:** S2 FAILS (bound 2,097,152,000).
- **Fix:** `min(…, 16 MiB)` (the largest note `sealNote` should accept), and refuse files over a few MB before decrypting.

**RR2-448-2 (LOW/INFO, confirmed): `publicHost` misses several private ranges.**
- **Where:** `linkShare.ts:57`. It misses IPv6 ULA (`fd00::/8`), link-local (`fe80::/10`), CGNAT `100.64/10`, `.internal`, `.lan`, `.home.arpa` and IPv4-mapped IPv6.
- **Scenario:** Links made there name an address only that network can open. This is usability only: the key stays in the fragment.
- **Test:** S3 FAILS (7 hosts kept).
- **Fix:** Extend the list. Or invert it: keep the page's origin only when it equals `VITE_SHARE_ORIGIN`, or the page is the public app.

**RR2-448-3 (LOW, from reading): the seam fails open silently.**
- **Where:** `src/share/shareReady.ts:34`. If `exportReady.ts` is ever renamed or moved, the glob finds nothing and links ship raw, and no test notices.
- **Fix:**
  - In the integration train, do the `TODO(#473)` now: a plain import.
  - Until then, add a train-only test, `expect(hasExportDoor()).toBe(true)`.
  - Add the share link to #473's every-export test.

## #469 (collab relay, free): fix 10820cc1b

- **#15 LOW: PARTIALLY FIXED.**
  - Fixed:
    - a socket with no token, a wrong token, or one that only read writes nothing and arms no alarm (lane R's harness `R/c469/run.mjs` 4/4);
    - the save is retried on failure.
  - Not addressed, and acknowledged in the PR: the cost of `checkE2eeUpdate`.

### New finding

**RR2-469-1 (MEDIUM, confirmed with lane R's fake relay): on the public relay the room token is free, so "authenticated" gates nothing.**
- **Where:** `edge-workers/collab/worker.mjs:74` (`accessKeyOk(req.key, env.COLLAB_ACCESS_KEY || "")`) and `sync-server/collab/roomToken.mjs:63` (`if (!expected) return true`). The public deployment sets no access key: `wrangler.toml` doesn't, `collab:deploy` sets only the token secret, and the docs say the server is free for everyone. `/token` therefore issues a token for **any** room name to an anonymous client. There is no per-address or global limit on rooms, writes or bytes.
- **Scenario:**
  - Anyone can make an anonymous `/token` request for room X, authenticate, and send one envelope-shaped update. Its `ct` is random, which passes `checkE2eeUpdate`. That writes Durable Object storage and re-arms the 90-day alarm.
  - Repeated over many room names, up to 4 MB each, this exhausts the Free plan's daily write quota or its 5 GB of storage. Every room's persistence then fails.
  - Any known room can be kept alive forever.
  - The new docs line ("Only a change by someone with the room's token counts") reads as a gate it isn't.
- **Test:** `rr2/c469/r469-free-token.mjs` FAILS: a token is issued with no key, then 2 storage writes and the alarm moved. It uses the real `worker.mjs`, a token from `/token`, `CollabRoom`, and lane R's fake relay. The real relay needs Yjs, which isn't available offline; building a valid envelope is from reading `relay.mjs`.
- **Fix:**
  - Rate-limit `/token` and new rooms per address (`CF-Connecting-IP`, hashed with a daily key as #483 does). Or issue tokens only to the room's creator, bound to a room secret derived from the room password, such as an HMAC proof the server can check without learning the key.
  - Add a global count of stored rooms and bytes, and refuse new rooms past it.
  - Correct the docs line.

---

## Notes

- Domain rule: no domain other than `lumen-md.vercel.app` appears in this report or the receipts.
- Tests not run, because the packages aren't available offline:
  - the real Yjs relay for #469;
  - `cliPublish.test.ts` for #473;
  - Firefox and WebKit for #451.
- The receipts' `files` list what I read for these fixes. For #483 and #488, the original PR's other sensitive files (the setup wizard, recovery words, and so on) were covered by review 12.11, not by this one. Their verdict is changes-requested anyway.
