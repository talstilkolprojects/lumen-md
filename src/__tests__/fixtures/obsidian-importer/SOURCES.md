# Sources: obsidian-importer test fixtures

Copied unchanged from the public repository of Obsidian Importer, for the
importer tests of plan W11.P1. They are the importer project's own sample
exports (made by its authors, not real users' data), so they are
**public examples, not real exports**: the real exports are W10.O9.

- Repository: https://github.com/obsidianmd/obsidian-importer
- Tag: `3.1.15`, commit `2b483d0b351c99efa8e2dd94baa8563c83d01c38` (2026-10-16)
- Path: `tests/keep/notes/*.json` → `keep/`
- Path: `tests/keep/notes/expected/<note>/<note>.md` → `keep-expected/<note>.md` (Obsidian Importer's own output for each note: the oracle of `import:diff`, plan W11.P2)
- Licence: MIT, © 2023 Obsidian (`LICENSE` in this folder, copied from the repository root)
- Copied: 2026-11-15

| file | bytes | sha256 |
|---|---|---|
| `keep/2023-08-01T14_29_43.842+10_00.json` | 303 | `ecf4cb6247780b5b1748f8dd3e7e988b05d68505ebaa3cee90ecdec0d3d4bb45` |
| `keep/Annotated note.json` | 626 | `5620cd1050c980e6f93b454939be244ae7ed859635ba56f23fd6e937d4b70f5d` |
| `keep/Archived note.json` | 248 | `9148459bc20a2c31620d4da3f3c57e23101c6e088563e20886380ea52f1b4ea1` |
| `keep/Background colour note.json` | 218 | `a91d84de50747d699cd6b73fde52b89d4b4840412a0fb4b67cbdec176bd30d57` |
| `keep/Checklist note.json` | 495 | `4c903990e6caab5e4c138d034b2dc59eab3e6c2ae9e15b0ae16853ea14e32402` |
| `keep/Deleted note.json` | 246 | `de677253a9e2afb076b5023c8c348e06c633e12c03a56fed90a07366801d8ffd` |
| `keep/Drawings (multiple) note.json` | 380 | `f8a77e32e08336006d0ee81c3a899ceb9838953353069460f756d3c298083ed1` |
| `keep/Hashtags _ labels note.json` | 1227 | `a06e08e663f80ff88dd5a8da03eda625faad662cc16c3d98beb77eedc38070f1` |
| `keep/Image, label, and body text note.json` | 344 | `12fde074f0d2b5f9b5c0b2529ecc5404b6e34ae692ceeb7876b049ac431c749b` |
| `keep/Invalid title characters note !@#$_^_()_+~`{}[]_.json` | 405 | `a2ada6fa330de8ea700502dfa3374db134753324ba4e7176793fa1d865ec3f79` |
| `keep/Labelled note.json` | 552 | `3738e40f3e51996fcb3c24935cb4f2ccce0223ad8bef1b37f65e4ed462c82842` |
| `keep/Multiline title note_Second line.json` | 262 | `d4159d76aaf777d1bf3759e13c6ca2e7771a5fec90502d62e9eedb3ac4a25e85` |
| `keep/Pinned text note.json` | 257 | `8c8f692e124f5de564588d358d72a5cd4481b2e07d19f1ebed7c724bcef460fa` |
| `keep/Rich checklist note.json` | 549 | `66b0eb7a056079d1b15edef9a5b4dd8e6903d89291735cf941e9cc90c3d04816` |
| `keep/Rich text note.json` | 1225 | `1f1c71af91f28d5af578c318b041c4e575737604dbba6aa0ae8f3d8cdb1bceb0` |
| `keep/Voice recording.json` | 338 | `f092c2905ffde80584ffee8ccef4da93b94681ef24072dca5a041950b3340e5c` |

| file (oracle output) | bytes | sha256 |
|---|---|---|
| `keep-expected/2023-08-01T14_29_43.842+10_00.md` | 106 | `08e51b3a2a2e194b928e5ba7d4fa98f63917500a0c74350984719d5bc67c154e` |
| `keep-expected/Annotated note.md` | 353 | `28129e9362d695c1c2f11807d8f946b73586fabaedf502d03b64f97252a4c3d2` |
| `keep-expected/Archived note.md` | 85 | `98f0ea0cc31e41072d11a5f11049fc888eea12114147ea28e8fcfe47ce91bc40` |
| `keep-expected/Background colour note.md` | 50 | `789a0887d1ff8e24469d82535818b64f999945312d20895b5428d56283fcd2c0` |
| `keep-expected/Checklist note.md` | 177 | `2f863432d47cbda801a52562854ac12d963d51b5a3926fafa8defc7889619dfe` |
| `keep-expected/Deleted note.md` | 83 | `2b85d2caecf53a0d777f1f5030a4793e59d023be40e0de86d401a3d4c5ed79db` |
| `keep-expected/Drawings (multiple) note.md` | 125 | `847a6a5a70eb193a4375c145d694cacb94fc0ae43d367da9c50892e6618c007c` |
| `keep-expected/Hashtags _ labels note.md` | 1040 | `e3a91e8a4fcdf95fcf57590022e7bc7ee732d212e0035bbf3b2c7a1878e9fb3e` |
| `keep-expected/Image, label, and body text note.md` | 131 | `b370b32c1ccb41848cc98f361619cd18865d3826f6f985c029a0442184669ccf` |
| `keep-expected/Invalid title characters note !@$__()_+~`{}_.md` | 238 | `01368059e770c078f9ab24327344e2466ad3324acfde1ad1997119a43c9a0e7c` |
| `keep-expected/Labelled note.md` | 373 | `e8727de6541a52ced4eabd626d3b4a89eb0fff7728b123430089cd90c8aee9b0` |
| `keep-expected/Multiline title note_Second line.md` | 104 | `f5aa98e7fe132c0f4dd4b56694bd9d1e5235d36aecc739652c8d62e644402c8c` |
| `keep-expected/Pinned text note.md` | 89 | `dfd4c19be0f8f1ff5adfee6575a0d897db9ef84925f239f09d51c7dee2fe4941` |
| `keep-expected/Rich checklist note.md` | 73 | `c3e44faa1d07654160d3f65103a84282f517241a1f05065c80f70abc8dc8b385` |
| `keep-expected/Rich text note.md` | 89 | `1153f2eeb2d0c5faf5eeb93e1eee3611c2bb17151f73006cd0ba119893f1afd0` |
| `keep-expected/Voice recording.md` | 126 | `48bcbfd4e86a14e8580743f08763a81c99b3c1b7785e079a9ea90ed7088a01f6` |
