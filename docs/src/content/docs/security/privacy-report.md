---
title: A privacy report you can prove
description: Export the privacy ledger as a signed report, check it with a script, and see the results of the outside audit for every version.
---

"Private" is a claim. Lumen lets you check it. The privacy ledger lists
every network request Lumen's features make. You can export it as a
**signed report**, check that report with a script, and compare it with
what an **outside network analyzer** saw during the same run.

## Export the report

⌘K → *Privacy ledger…* → **Export signed report**. The file covers this
session, from when the tab opened. For each request it says:

| | |
|---|---|
| Who | Which feature (its category and reason: "Anthropic (Claude)", "Model download", …) |
| When | The time |
| Where | The host |
| How much | Bytes sent and received, and whether it was allowed or blocked |

The summary (requests, how many left the device and to which hosts, bytes)
is computed from those entries. The file holds no prompt, note or header.

It is signed in the browser with **Ed25519**, using a key made on this device
the first time you export. The private half stays in IndexedDB and can't be
exported. The signature uses the minisign format, so both the script below
and the `minisign` tool can verify it.

## Check a report

```sh
node scripts/privacy/verify-report.mjs lumen-privacy-report-….json
node scripts/privacy/verify-report.mjs report.json --local-only          # also: nothing left the device
node scripts/privacy/verify-report.mjs report.json --pub device.pub      # pin the signing key
node scripts/privacy/verify-report.mjs report.json --extract out/        # then: minisign -Vm out/report.json -p out/report.pub
```

The script checks the signature and the trusted comment (which names the
report's SHA-256), and that the report is in its canonical form. It checks
the shape of every entry: times inside the session and in order,
`leftDevice` following the ledger's rule. It then **works the summary out
again** and refuses a report whose summary disagrees with its entries.
Without `--pub`, it proves the file hasn't changed since it was signed. With
`--pub`, it also proves which device signed it.

## Audit mode

The ledger normally lists AI traffic. In **audit mode**
(`localStorage["lumen.privacy.audit"] = "1"`) it also lists every other
request that leaves the device and the LAN, as *Other request*. Those are
listed but never blocked. The app is then run through an outside analyzer:

```sh
node scripts/privacy/audit.mjs --sign ~/.lumen-release/lumen-release.key --publish
```

1. **mitmproxy** (`mitmdump`, 10.1 or newer) records every request,
   including the app's own requests to the dev server, which proves it was
   in the path.
2. `e2e/privacy-audit.spec.ts` runs the journey under the **local-only**
   policy with cloud keys set to tempt every fallback: the views, an export,
   the AI commands, and a hand-made cloud request (which is blocked). It then
   exports the signed report and keeps Playwright's own request log.
3. The script verifies the report and compares it with **both** observers.
   The audit passes only when each observer saw traffic, nothing it saw
   leaving is missing from the report, nothing the report lists is missing
   from the wire, and **0 requests are non-local**.
4. `audit.json` is signed with the [release key](/security/supply-chain/)
   and published below.

## Results per version

Every version since the first audit has its row. `publish.mjs --check`
fails when a released version (in `CHANGELOG.md`) has no audit file in
`security/privacy-audits/`.

<!-- audits:start -->
_No audit published yet: the first runs with the first release after this page._
<!-- audits:end -->

## Store privacy labels

`store/privacy-labels.json` is the source for the App Store's *App Privacy*
answers and Google Play's *Data safety* form:

- **Data not collected.** With default settings nothing leaves the device,
  which is what the local-only audit shows.
- **Crash data, only on one condition:** the build has a crash-reporting key
  and the user hasn't opted out. It isn't linked to the user and isn't used
  for tracking.
- Every optional feature that can send something, mapped to its category in
  the ledger.

A test keeps the labels in step with the ledger's categories, the crash
reporter and the published audits.
