# winget manifest schemas (vendored)

- From https://github.com/microsoft/winget-cli, `schemas/JSON/manifests/v1.6.0/`,
  commit `7de3b02def71f06e43cda719d52bc379c00e9021`, unchanged.
- Licence: MIT, Copyright (c) Microsoft Corporation (see `LICENSE` here).
- Used offline by `scripts/lib/packaging-check.mjs` (plan W1.24) to validate the
  winget manifests `node scripts/release.mjs packages` writes. Nothing is
  submitted anywhere.
