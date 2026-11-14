#!/usr/bin/env bash
# Self-test of the verification factory (plan W6.5) without Docker, a VM or
# GitHub: `bash scripts/factory/selftest.sh` (npm run factory:selftest).
#
# What is real here: bash, git, node, the bootstrap script and run.mjs
# themselves, the Ed25519 signing and checking (scripts/nightly/receipt.mjs),
# a lumen-md stand-in repository with two verify/* heads and a receipts
# repository (both local bare repositories).
# What is emulated, by small programs put first on PATH:
#   docker     `run -d … -v <dir>:/lumen` remembers the directory; `exec` runs the command there
#   npm        `ci` does nothing; `run <script>` runs package.json's script with bash
#   gh         records every call; answers the PR lookup with #455
#   apt-get, systemctl, useradd, usermod, chown, sudo, launchctl, cargo, uname (for the Mac pass)
#   the deploy key is a stand-in text (the receipts remote is a local path; ssh is never used)
#   npx        `vite build` makes an empty dist; the BrowserStack SDK writes a Playwright JSON report
#              with one project per Safari platform (iOS 17 fails on verify/train)
# What does NOT run: a real Docker daemon or image, npm install, vitest,
# Playwright and its browsers, BrowserStack, cargo, systemd, launchd, GitHub's API.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; TOOL="$(cd "$HERE/../.." && pwd)"
T="$(mktemp -d)"; if [ -n "${LUMEN_SELFTEST_KEEP:-}" ]; then echo "(keeping $T)"; else trap 'rm -rf "$T"' EXIT; fi
pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
no() { echo "  ✗ $1"; fail=$((fail + 1)); }
expect() { if eval "$2"; then ok "$1"; else no "$1"; fi; }
G=(git -c user.name=t -c user.email=t@example.com -c init.defaultBranch=main -c core.hooksPath=/dev/null -c push.negotiate=false)

# ── fakes ──────────────────────────────────────────────────────────────────
mkdir -p "$T/bin" "$T/state"
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
S="$FAKE_STATE"; echo "docker $*" >> "$S/docker.log"
case "$1" in
  image) [ -f "$S/image-built" ] ;;
  build) touch "$S/image-built" ;;
  info) echo "docker fake on $(uname -m)" ;;
  rm) exit 0 ;;
  run) shift; name=""; dir=""; tool=""
       while [ $# -gt 0 ]; do case "$1" in --name) name="$2"; shift 2 ;; -v) case "$2" in *:/lumen) dir="${2%:/lumen}" ;; *:/tool:ro) tool="${2%:/tool:ro}" ;; esac; shift 2 ;; -u|-e|-w) shift 2 ;; *) shift ;; esac; done
       echo "$dir" > "$S/ctr-$name"; echo "${tool:-}" > "$S/tool-$name"; echo "fake-container-$name" ;;
  exec) shift; envs=()
        while [ $# -gt 0 ]; do case "$1" in -e) envs+=("$2"); shift 2 ;; -w) shift 2 ;; *) break ;; esac; done
        name="$1"; shift; [ "${1:-}" = pkill ] && exit 0
        tool="$(cat "$S/tool-$name")"; args=(); for a in "$@"; do args+=("${a/#\/tool\//$tool/}"); done   # the /tool mount
        cd "$(cat "$S/ctr-$name")" && exec env "${envs[@]}" "${args[@]}" ;;
  *) echo "fake docker: unhandled $1" >&2; exit 3 ;;
esac
EOF
cat > "$T/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_STATE/npm.log"
case "$1" in
  ci) echo "added 0 packages (fake)";;
  run) s=$(node -p "require('./package.json').scripts['$2'] ?? ''"); [ -n "$s" ] || { echo "no script $2" >&2; exit 1; }; bash -c "$s" ;;
  *) exit 0 ;;
esac
EOF
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "gh $* GH_TOKEN=${GH_TOKEN:+set}" >> "$FAKE_STATE/gh.log"
case "$*" in
  *"/pulls --jq"*) echo 455 ;;
  *"repos/talstilkol/lumen-md --jq"*) echo "token ok: talstilkol/lumen-md" ;;
  *"-X POST"*) echo '{}' ;;
esac
EOF
for t in apt-get systemctl useradd usermod launchctl chown; do printf '#!/usr/bin/env bash\necho "%s $*" >> "$FAKE_STATE/system.log"\n' "$t" > "$T/bin/$t"; done
# sudo -u <user> -H cmd… → cmd… (the stand-in user is the one running the test)
printf '#!/usr/bin/env bash\necho "sudo $*" >> "$FAKE_STATE/system.log"\nwhile [ "${1:-}" = -u ] || [ "${1:-}" = -H ]; do [ "$1" = -u ] && shift; shift; done\nexec "$@"\n' > "$T/bin/sudo"
chmod +x "$T/bin"/*
export PATH="$T/bin:$PATH" FAKE_STATE="$T/state"

# ── a lumen-md stand-in: the factory's branch and two verify/* heads ───────
echo "▶ fixture repositories"
"${G[@]}" init -q --bare "$T/lumen.git"; "${G[@]}" init -q --bare "$T/receipts.git"
"${G[@]}" clone -q "$T/receipts.git" "$T/r0" 2>/dev/null; echo "# receipts" > "$T/r0/README.md"
(cd "$T/r0" && "${G[@]}" add -A && "${G[@]}" commit -qm init && "${G[@]}" push -q origin HEAD:main)
mkdir -p "$T/tool/scripts"; cp -r "$TOOL/scripts/factory" "$TOOL/scripts/nightly" "$TOOL/scripts/safari" "$TOOL/scripts/promote" "$T/tool/scripts/"
(cd "$T/tool" && "${G[@]}" init -q && "${G[@]}" add -A && "${G[@]}" commit -qm tool && "${G[@]}" push -q "$T/lumen.git" HEAD:refs/heads/chore/verify-factory)
mk_head() { # mk_head <branch> <webkit fails 0|1>
  local d="$T/head-${1//\//-}"; mkdir -p "$d/scripts/nightly" "$d/src-tauri"
  cat > "$d/package.json" <<'EOF'
{ "name": "fixture", "scripts": { "drill:data-safety": "node -e \"console.log('drill: 0 damaged')\"" } }
EOF
  echo '{ "packages": { "node_modules/@playwright/test": { "version": "1.59.1" } } }' > "$d/package-lock.json"
  cat > "$d/scripts/nightly/plan.mjs" <<EOF
// The fixture's own plan: the same shape as the real scripts/nightly/plan.mjs (W6.8).
const vit = (i) => "require('fs').mkdirSync('reports/nightly',{recursive:true});require('fs').writeFileSync('reports/nightly/vitest-"+i+"of2.json',JSON.stringify({numTotalTests:3,numPassedTests:3,numFailedTests:0,testResults:"+(i===1?"[{name:'/lumen/src/__tests__/e2eeUi.test.tsx',status:'passed'},{name:'/lumen/src/__tests__/pdfReader.test.tsx',status:'passed'}]":"[{name:'/lumen/src/__tests__/dictationLocal.test.ts',status:'passed'},{name:'/lumen/src/__tests__/vaultEncryption.test.ts',status:'passed'}]")+"}))";
const e2e = (b, i, bad) => "require('fs').mkdirSync('reports/nightly',{recursive:true});require('fs').writeFileSync('reports/nightly/e2e-"+b+"-"+i+"of2.json',JSON.stringify({stats:{expected:4,unexpected:"+(bad?1:0)+",flaky:0,skipped:0},suites:[{file:'smoke.spec.ts',specs:[{title:'opens a note',tests:[{status:'"+(bad?"unexpected":"expected")+"'}]}]}]}));process.exit("+(bad?1:0)+")";
export function fullSteps() {
  const s = [{ id: "build", group: "build", cmd: ["node", "-e", "console.log('built')"], timeoutMin: 1 }];
  for (const i of [1, 2]) s.push({ id: "vitest-" + i + "of2", group: "vitest", parallel: true, cmd: ["node", "-e", vit(i)], timeoutMin: 1 });
  for (const b of ["chromium", "firefox", "webkit"]) for (const i of [1, 2]) s.push({ id: "e2e-" + b + "-" + i + "of2", group: "e2e", parallel: true, cmd: ["node", "-e", e2e(b, i, b === "webkit" && i === 2 && $2)], timeoutMin: 1 });
  s.push({ id: "vercel-ignore-step", group: "vercel", cmd: ["node", "-e", "process.exit(2)"], timeoutMin: 1 });
  return s;
}
EOF
  echo '[package]' > "$d/src-tauri/Cargo.toml"
  mkdir -p "$d/e2e" && echo "// smoke" > "$d/e2e/smoke.spec.ts"
  (cd "$d" && "${G[@]}" init -q && "${G[@]}" add -A && "${G[@]}" commit -qm "head $1" && "${G[@]}" push -q "$T/lumen.git" "HEAD:refs/heads/$1")
}
mk_head verify/train 1
mk_head verify/e2e-probe-1 0
# cargo is not in the fake image: a stand-in that says what it would check.
printf '#!/usr/bin/env bash\necho "cargo $* (fake)"\n' > "$T/bin/cargo"; chmod +x "$T/bin/cargo"

# ── 1. bootstrap --dry-run (Ubuntu) ────────────────────────────────────────
echo "▶ 1. bootstrap --dry-run on Ubuntu"
out="$(LUMEN_FACTORY_REMOTE="$T/lumen.git" bash "$HERE/bootstrap.sh" --dry-run 2>&1)" || true
expect "prints the seven stages" '[ "$(grep -c "^.*▶ [1-7]/7" <<<"$out")" -ge 6 ]'
expect "installs docker.io, git, gh" 'grep -q "apt-get install -y -q docker.io git gh" <<<"$out"'
expect "enables the timer" 'grep -q "systemctl enable --now lumen-factory.timer" <<<"$out"'
expect "would write the unit, timer and env" '[ "$(grep -c "+ write .*\(lumen-factory.service\|lumen-factory.timer\|/env\)" <<<"$out")" = 3 ]'
expect "changed nothing on the machine" '[ ! -s "$T/state/system.log" ]'

# ── 2. bootstrap for real, under a temp root, with the fakes ───────────────
echo "▶ 2. bootstrap (Ubuntu path) into a temp root"
R="$T/root"; mkdir -p "$R"
# A stand-in deploy key (the receipts remote here is a local path, so ssh never reads it).
printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nc2VsZnRlc3Q=\n-----END OPENSSH PRIVATE KEY-----\n' > "$T/deploy"
{ echo "github_pat_11AAAAAAA0selftestselftestselftest"; cat "$T/deploy"; } > "$T/secrets"
if LUMEN_FACTORY_ROOT="$R" LUMEN_FACTORY_REMOTE="$T/lumen.git" LUMEN_RECEIPTS_REMOTE="$T/receipts.git" LUMEN_FACTORY_HOST=selftest \
   bash "$HERE/bootstrap.sh" --secrets-stdin --at 02:05 < "$T/secrets" > "$T/boot.log" 2>&1; then ok "bootstrap exits 0"; else no "bootstrap exits 0 (see below)"; tail -20 "$T/boot.log"; fi
F="$R/srv/lumen-factory"; E="$R/etc/lumen-factory"
expect "token stored with mode 600" '[ "$(stat -c %a "$E/token")" = 600 ] && grep -q github_pat_ "$E/token"'
expect "deploy key stored with mode 600" '[ "$(stat -c %a "$F/.ssh/receipts_deploy")" = 600 ]'
expect "the timer runs at 02:05 Israel time, persistent" 'grep -q "OnCalendar=\*-\*-\* 02:05:00 Asia/Jerusalem" "$R/etc/systemd/system/lumen-factory.timer" && grep -q Persistent=true "$R/etc/systemd/system/lumen-factory.timer"'
expect "the service runs run.mjs --scheduled as lumen" 'grep -q "^User=lumen" "$R/etc/systemd/system/lumen-factory.service" && grep -q "run.mjs --scheduled" "$R/etc/systemd/system/lumen-factory.service"'
expect "the factory code is cloned from its branch" '[ "$(git -C "$F/tool" rev-parse --abbrev-ref HEAD)" = chore/verify-factory ]'
expect "the signing key exists with mode 600" '[ "$(stat -c %a "$F/.config/lumen-md/nightly-ed25519.pem")" = 600 ]'
expect "the token was checked with gh" 'grep -q "gh api repos/talstilkol/lumen-md --jq .* GH_TOKEN=set" "$T/state/gh.log"'
expect "the swap file is left alone under a temp root" '[ ! -e "$R/swapfile" ]'
grep -q "token ok" "$T/boot.log" && ok "bootstrap's own check passed" || no "bootstrap's own check"

# ── 3. one night ───────────────────────────────────────────────────────────
echo "▶ 3. a night: two heads, webkit fails on verify/train"
set -a; . "$E/env"; set +a
export LUMEN_FACTORY_RERUN_DAY=none
code=0; node "$F/tool/scripts/factory/run.mjs" --scheduled > "$T/night1.log" 2>&1 || code=$?
expect "the night exits 1 (a suite failed)" '[ "$code" = 1 ]'
git -C "$T/receipts.git" log --format=%s -1 main > "$T/last" 2>/dev/null || true
expect "receipts were pushed to the receipts repository" 'grep -q "night .*: 2 run, 0 unchanged (selftest)" "$T/last"'
git clone -q "$T/receipts.git" "$T/rc"
TRAIN=$(git -C "$T/lumen.git" rev-parse refs/heads/verify/train)
RF=$(ls "$T/rc/commits/$TRAIN"/full-*.json | head -1)
expect "a full receipt for verify/train's exact commit" '[ -f "$RF" ]'
v=$(cd "$T/rc" && node --input-type=module -e "
  const { check } = await import('$F/tool/scripts/nightly/receipt.mjs');
  const fs = await import('node:fs');
  const r = JSON.parse(fs.readFileSync('$RF','utf8')); const pub = fs.readFileSync('keys/selftest.pem','utf8');
  const forged = { ...r, suites: { ...r.suites, 'e2e webkit': { ok: true, detail: 'forged' } } };
  console.log([check(r, pub).ok, check(forged, pub).ok, r.suites['e2e webkit'].ok, r.suites['e2e chromium'].ok, r.suites.vitest.ok, r.mustRun.every(m => m.ran && m.ok), r.plan, (r.suites['cargo-check']||{}).ok, (r.suites['drill-data-safety']||{}).ok, r.steps.some(s => s.group === 'vercel')].join(' '));")
expect "the receipt verifies against keys/selftest.pem; a forged copy does not" '[ "$(cut -d" " -f1,2 <<<"$v")" = "true false" ]'
expect "webkit failed, chromium and vitest passed, the 4 must-run suites ran" '[ "$(cut -d" " -f3-6 <<<"$v")" = "false true true true" ]'
expect "steps from the head's plan.mjs, cargo and the drill ran, the Vercel step left out" '[ "$(cut -d" " -f7-10 <<<"$v")" = "scripts/nightly/plan.mjs true true false" ]'
expect "a failure status for e2e webkit on that commit" 'grep -q "statuses/$TRAIN -f state=failure -f context=lumen/factory: e2e webkit" "$T/state/gh.log"'
expect "a success status for e2e chromium" 'grep -q "statuses/$TRAIN -f state=success -f context=lumen/factory: e2e chromium" "$T/state/gh.log"'
expect "statuses link to the receipt" 'grep -q "target_url=https://github.com/talstilkol/lumen-md-receipts/blob/main/commits/$TRAIN/full-" "$T/state/gh.log"'
D=$(date -u +%F)
expect "the morning report names the failing test and its PR" 'grep -q "e2e webkit: e2e/smoke.spec.ts › opens a note — last changed in #455" "$T/rc/nights/$D.md"'
expect "the image was built once for Playwright 1.59.1" '[ "$(grep -c "^docker build .*PW_VERSION=1.59.1" "$T/state/docker.log")" = 1 ]'
expect "each head ran in its own container with the worktree at /lumen" '[ "$(grep -c "^docker run -d --name lumen-factory-" "$T/state/docker.log")" = 2 ]'

# ── 4. the next night: nothing changed → heartbeats, no re-run ─────────────
echo "▶ 4. the next night: unchanged heads"
before=$(grep -c "^docker run" "$T/state/docker.log")
code=0; node "$F/tool/scripts/factory/run.mjs" --scheduled > "$T/night2.log" 2>&1 || code=$?
expect "exits 0 (nothing ran, nothing failed)" '[ "$code" = 0 ]'
expect "no container was started" '[ "$(grep -c "^docker run" "$T/state/docker.log")" = "$before" ]'
expect "the heartbeat names the receipt of the same commit" 'grep -q "verify/train @ .*covered by commits/$TRAIN/full-" "$T/night2.log"'

# ── 5. bootstrap --dry-run on a Mac (uname faked) ──────────────────────────
echo "▶ 5. bootstrap --dry-run on a Mac"
printf '#!/usr/bin/env bash\n[ "${1:-}" = -s ] && echo Darwin || /usr/bin/uname "$@"\n' > "$T/bin/uname"; chmod +x "$T/bin/uname"
: > "$T/state/system.log"
out="$(HOME="$T/mac" LUMEN_FACTORY_REMOTE="$T/lumen.git" bash "$HERE/bootstrap.sh" --dry-run 2>&1)" || true
expect "loads a LaunchAgent instead of systemd" 'grep -q "launchctl bootstrap gui/" <<<"$out" && ! grep -q "systemctl enable" <<<"$out"'
expect "no apt-get on the Mac" '! grep -q "apt-get install" <<<"$out"'
expect "runs natively (no Docker)" 'grep -q "+ write .*dev.lumen-md.factory.plist" <<<"$out"'

# ── 6. real Safari (BrowserStack emulated), then promote:check ─────────────
echo "▶ 6. Safari on BrowserStack (emulated) and promote:check"
rm -f "$T/bin/uname"
cat > "$T/bin/npx" <<'NPX'
#!/usr/bin/env bash
echo "npx $*" >> "$FAKE_STATE/npx.log"
if [ "$1" = vite ] && [ "$2" = build ]; then mkdir -p .factory/dist-safari && echo "<html></html>" > .factory/dist-safari/index.html; exit 0; fi
if [ "$1" = -y ] && [ "$3" = playwright ]; then
  [ -f browserstack.yml ] && [ -f .factory/playwright.browserstack.config.mjs ] || { echo "no browserstack.yml or config" >&2; exit 3; }
  bad=0; git log -1 --format=%s | grep -q "verify/train" && bad=1
  node -e '
    const bad = process.argv[1] === "1";
    const projects = ["iPhone 17 26 safari", "iPhone 16 18 safari", "iPhone 15 17 safari", "OS X Sequoia playwright-webkit"];
    const specs = projects.map((p) => ({ title: "keeps the note", file: "data-safety.spec.ts", tests: [{ projectName: p, status: bad && p.startsWith("iPhone 15") ? "unexpected" : "expected" }] }));
    require("fs").writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [{ file: "data-safety.spec.ts", specs }] }));
    process.exit(bad ? 1 : 0);' "$bad"
  exit $?
fi
echo "fake npx: unhandled $*" >&2; exit 3
NPX
chmod +x "$T/bin/npx"
export BROWSERSTACK_USERNAME=selftest BROWSERSTACK_ACCESS_KEY=selftest-secret-key LUMEN_FACTORY_SAFARI_BRANCHES='.*'
code=0; node "$F/tool/scripts/factory/run.mjs" --scheduled --rerun > "$T/night3.log" 2>&1 || code=$?
expect "the night ran both heads again (--rerun)" 'grep -q "2 to run" "$T/night3.log"'
expect "the container gets the BrowserStack credentials by name, never the value in argv" 'grep -q -- "-e BROWSERSTACK_USERNAME -e BROWSERSTACK_ACCESS_KEY" "$T/state/docker.log" && ! grep -q selftest-secret-key "$T/state/docker.log"'
expect "the SDK ran the five Safari specs on each head" '[ "$(grep -c "browserstack-node-sdk playwright test -c .factory/playwright.browserstack.config.mjs e2e/smoke.spec.ts e2e/rtl.spec.ts e2e/first-run.spec.ts e2e/locale-switch.spec.ts e2e/data-safety.spec.ts" "$T/state/npx.log")" = 2 ]'
git clone -q "$T/receipts.git" "$T/rc2"
PROBE=$(git -C "$T/lumen.git" rev-parse refs/heads/verify/e2e-probe-1)
PF=$(ls -t "$T/rc2/commits/$PROBE"/full-*.json | head -1)
nsafari=$(node -e 'const r=require(process.argv[1]);console.log(Object.entries(r.suites).filter(([n,s])=>n.startsWith("safari ")&&s.ok).length)' "$PF")
expect "the probe's receipt has four passing Safari suites" '[ "$nsafari" = 4 ]'
expect "a Safari commit status was posted" 'grep -q "context=lumen/factory: safari ios 17 (iPhone 15)" "$T/state/gh.log"'
git clone -q "$T/lumen.git" "$T/cand" 2>/dev/null
pcode() { local c=0; (cd "$T/cand" && node "$F/tool/scripts/promote/check.mjs" "$@") > "$T/pc.log" 2>&1 || c=$?; echo "$c"; }
expect "promote:check passes the probe: WebKit and Safari passed on that commit" '[ "$(pcode "$PROBE" --receipts "$T/rc2")" = 0 ]'
expect "promote:check refuses verify/train: WebKit failed" '[ "$(pcode "$TRAIN" --receipts "$T/rc2")" = 1 ] && grep -q "✗ WebKit" "$T/pc.log"'
expect "it names the failing Safari platform too" 'grep -q "✗ safari ios 17 (iPhone 15)" "$T/pc.log"'
(cd "$T/cand" && "${G[@]}" checkout -q --detach "$PROBE" && "${G[@]}" commit -q --allow-empty -m "merge into main, same tree")
SAME=$(git -C "$T/cand" rev-parse HEAD)
expect "a commit with the same tree as the probe passes" '[ "$(pcode "$SAME" --receipts "$T/rc2")" = 0 ]'
echo "change" > "$T/cand/extra.txt"; (cd "$T/cand" && "${G[@]}" add extra.txt && "${G[@]}" commit -qm "one more change")
expect "a commit with another tree is refused: no receipt" '[ "$(pcode HEAD --receipts "$T/rc2")" = 1 ] && grep -q "no receipt for" "$T/pc.log"'
cp -r "$T/rc2" "$T/rc3"
node -e 'const f=process.argv[1];const r=JSON.parse(require("fs").readFileSync(f,"utf8"));r.suites["e2e webkit"].detail="edited";require("fs").writeFileSync(f,JSON.stringify(r))' "${PF/rc2/rc3}"
# The edited receipt no longer verifies; the probe's first receipt (night 1, no Safari) still does, so Safari is missing.
expect "an edited receipt does not count" '[ "$(pcode "$PROBE" --receipts "$T/rc3")" = 1 ] && grep -q "digest does not match" "$T/pc.log"'
expect "an unknown pinned key: cannot check (exit 2)" '[ "$(pcode "$PROBE" --receipts "$T/rc2" --pin 0000000000000000)" = 2 ]'
KEYFP=$(node -e 'const c=require("crypto");console.log(c.createHash("sha256").update(require("fs").readFileSync(process.argv[1],"utf8")).digest("hex").slice(0,16))' "$T/rc2/keys/selftest.pem")
expect "the right pinned key: passes" '[ "$(pcode "$PROBE" --receipts "$T/rc2" --pin "$KEYFP")" = 0 ]'

echo
echo "factory self-test: $pass passed, $fail failed"
[ "$fail" = 0 ]
