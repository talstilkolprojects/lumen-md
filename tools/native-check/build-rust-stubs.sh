#!/bin/bash
# Build the stub crates (plan W4.23) into $OUT. FEATURES: tauri features (e.g. "tray-icon").
set -e
D=$(cd "$(dirname "$0")" && pwd); ST=$D/rust-stubs; OUT=${OUT:-$D/out}; mkdir -p "$OUT"
R="rustc --edition 2021 -A warnings -L $OUT --out-dir $OUT"
FEAT=(); for f in $FEATURES; do FEAT+=(--cfg "feature=\"$f\""); done
$R --crate-type proc-macro --crate-name serde_derive $ST/serde_derive.rs --extern proc_macro
$R --crate-type proc-macro --crate-name tauri_macros $ST/tauri_macros.rs --extern proc_macro
$R --crate-type rlib --crate-name serde $ST/serde.rs --extern serde_derive
$R --crate-type rlib --crate-name serde_json $ST/serde_json.rs --extern serde
$R --crate-type rlib --crate-name url $ST/url.rs --extern serde
$R --crate-type rlib --crate-name tauri $ST/tauri.rs --extern serde --extern serde_json --extern url --extern tauri_macros "${FEAT[@]}"
for p in fs dialog deep_link single_instance updater; do
  $R --crate-type rlib --crate-name tauri_plugin_$p $ST/tauri_plugin_$p.rs --extern tauri --extern url --extern serde --extern serde_json $([ $p = dialog ] && echo --extern tauri_plugin_fs)
done
echo "stubs built in $OUT"
