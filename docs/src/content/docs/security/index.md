---
title: Security
description: Lumen's security status in public: the external audit (none yet), the threat model, fuzzing, release provenance, every open finding, and a review scorecard with a privacy label for each plugin.
---

<!-- Written by scripts/security-page.mjs from security/findings.json and the plugin scorecards. Do not edit by hand. -->

This page is written from the repository itself: the findings register (`security/findings.json`) and the plugin scorecards (`public/plugins/examples/scorecards/`). A test fails when the page is out of date, so an open finding can't be left off it.

## External audit

Lumen has not had an external security audit. One is to be commissioned (plan W11.O6) for the sync protocol and the keyring. Until a report is published in full, nothing may call Lumen's cryptography audited, and encrypted sync (E2EE) is to be off by default with the label "experimental — not externally audited" (plan W11.S1, tracked on its own; launch gate M0 checks it).

## Threat model

What is protected, who we defend against, and the known gaps: [Threat model](/security/threat-model/).

## Fuzzing

The decoders are fuzzed (`npm run fuzz`, 1,000,000 inputs per decoder); how and what is covered: [Supply chain](/security/supply-chain/). Results per release are not published on this page yet.

## Release provenance (SLSA)

Releases are built to carry signatures and SLSA provenance (`npm run release:sign`, `npm run release:verify`, plan W7.22); see [Supply chain](/security/supply-chain/). No signed release has been published yet: the first is 0.2.0-beta.1 (launch gate M0).

## Open findings

Every finding that is still open or accepted, with its severity. A finding leaves this list only when it is fixed, with the change that fixed it.

| id | severity | area | finding | since |
|---|---|---|---|---|
| LUM-2026-001 | medium | sync | Encrypted sync (E2EE) has had no external audit. | 2026-11-15 |
| LUM-2026-003 | medium | agents | An agent granted `write` writes without asking again for each file. | 2026-11-15 |
| LUM-2026-004 | medium | vault | A copied browser profile can use the stored secret key without a password until whole-vault encryption (11.4) ships. | 2026-11-15 |
| LUM-2026-002 | low | collaboration | Collaboration edits are attributed locally, not signed. | 2026-11-15 |
| LUM-2026-005 | low | clipper | The web clipper's `<all_urls>` host permission is broader than its click-only behaviour needs. | 2026-11-15 |
| LUM-2026-006 | low | fuzzing | The fuzzer does not cover `.base`, `.excalidraw`, PDF annotations or plugin manifests yet. | 2026-11-15 |
| LUM-2026-007 | low | plugins | The plugin review does not run `npm audit` on a version's lockfile offline; such a version is marked "audit owed" until it runs. | 2026-11-15 |

## Plugin review scorecards

Every version of every plugin in the registry goes through an automated review before it is listed (plan W11.S14): static analysis (eval, Function, obfuscation, minified-only bundles, undeclared network origins), its permissions against the previous version, its stylesheet (no remote `@import` or `url()`), and a public source. A version that fails is not listed; a listed version whose review failed is taken down within 24 hours. The privacy label comes from the permissions the manifest declares.

| plugin | version | grade | score | privacy label |
|---|---|---|---|---|
| `lumen.calendar` | 1.0.0 | A | 90 | Keeps its settings; Reads notes in your vault; Collects nothing: no network access |
| `lumen.example.bidi-cleaner` | 1.0.0 | A | 90 | Reads the open note; Changes the open note; Shows notifications; Collects nothing: no network access |
| `lumen.example.callout` | 1.0.0 | A | 90 | Keeps its own data on this device; Collects nothing: no network access |
| `lumen.example.daily-quote` | 1.0.0 | A | 90 | Changes the open note; Can send data to https://example.com; Shows notifications |
| `lumen.example.hebrew-date` | 1.0.0 | A | 90 | Changes the open note; Collects nothing: no network access |
| `lumen.example.tasks-overview` | 1.0.0 | A | 90 | Reads notes in your vault; Collects nothing: no network access |
| `lumen.example.text-format` | 1.0.0 | A | 90 | Reads the open note; Changes the open note; Collects nothing: no network access |
| `lumen.example.toc` | 1.0.0 | A | 90 | Reads the open note; Changes the open note; Keeps its settings; Collects nothing: no network access |
| `lumen.example.word-stats` | 1.0.0 | A | 90 | Reads the open note; Keeps its settings; Collects nothing: no network access |
| `lumen.flashcards` | 1.0.0 | A | 90 | Reads the open note; Keeps its own data on this device; Collects nothing: no network access |
| `lumen.kanban` | 1.0.0 | A | 90 | Writes to the clipboard; Reads the open note; Changes the open note; Shows notifications; Collects nothing: no network access |
| `lumen.linter` | 1.0.0 | A | 90 | Reads the open note; Changes the open note; Shows notifications; Keeps its settings; Collects nothing: no network access |
| `lumen.natural-dates` | 1.0.0 | A | 90 | Reads the open note; Changes the open note; Shows notifications; Keeps its settings; Collects nothing: no network access |
| `lumen.note-refactor` | 1.0.0 | A | 90 | Reads the open note; Changes the open note; Shows notifications; Keeps its settings; Reads notes in your vault; Changes notes in your vault; Collects nothing: no network access |
| `lumen.sort-lines` | 1.0.0 | A | 90 | Reads the open note; Changes the open note; Shows notifications; Collects nothing: no network access |
| `lumen.table-format` | 1.0.0 | A | 90 | Reads the open note; Changes the open note; Collects nothing: no network access |
| `lumen.tags` | 1.0.0 | A | 90 | Shows notifications; Reads notes in your vault; Changes notes in your vault; Collects nothing: no network access |
| `lumen.templates` | 1.0.0 | A | 90 | Reads the open note; Changes the open note; Keeps its settings; Reads notes in your vault; Collects nothing: no network access |

## Report a vulnerability

Privately, as [SECURITY.md](https://github.com/talstilkol/lumen-md/blob/main/SECURITY.md) explains.
