#!/usr/bin/env bash
# Self-test of the Buildkite CI (plan W7.21) without Buildkite, Docker or
# GitHub: `bash scripts/buildkite/selftest.sh` (npm run ci:selftest).
#
# Real here: bash, node, git, the pipeline generator against the real ci.yml,
# the generated job commands themselves (after Buildkite's `$$` → `$`), run.sh,
# the shard planner on the real test files, the Ed25519 receipt (seal, verify,
# a one-byte change rejected), the trigger against a local HTTP server that
# answers like GitHub's and Buildkite's REST APIs, and agent-bootstrap.sh into
# a temporary root.
# Emulated by small programs first on PATH: docker (runs the job script on
# this machine), npm/npx (record the call; a chosen script fails), buildkite-agent,
# gh, apt-get, gpg, curl, systemctl, chown, brew, launchctl, uname (the Mac pass).
# Not run: a real agent, Buildkite itself, Docker, vitest, Playwright, systemd, launchd.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; TOOL="$(cd "$HERE/../.." && pwd)"
T="$(mktemp -d)"; if [ -n "${LUMEN_SELFTEST_KEEP:-}" ]; then echo "(keeping $T)"; else trap 'rm -rf "$T"; rm -rf "$TOOL/ci-out/.selftest"' EXIT; fi
pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
no() { echo "  ✗ $1"; fail=$((fail + 1)); }
expect() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

# ci.yml parsed: the yaml package after npm ci, else python3's (a machine without node_modules)
CI_JSON="$T/ci.json"
if node -e 'require.resolve("yaml")' 2>/dev/null; then
  node --input-type=module -e "import {parse} from 'yaml'; import {readFileSync,writeFileSync} from 'node:fs'; writeFileSync('$CI_JSON', JSON.stringify(parse(readFileSync('$TOOL/.github/workflows/ci.yml','utf8'), {uniqueKeys:false})))"
else
  python3 -I -c "import yaml,json,sys; json.dump(yaml.safe_load(open(sys.argv[1])), open(sys.argv[2],'w'))" "$TOOL/.github/workflows/ci.yml" "$CI_JSON"
fi
# pipeline.yml as JSON, with Buildkite's upload-time interpolation of `$$` applied
PIPE_JSON="$T/pipeline.json"
python3 -I -c "
import yaml,json,sys
p=yaml.safe_load(open(sys.argv[1]))
for s in p['steps']: s['command']=s['command'].replace('\$\$','\x00').replace('\x00','\$')
json.dump(p, open(sys.argv[2],'w'))" "$TOOL/.buildkite/pipeline.yml" "$PIPE_JSON"
cmd() { node -e 'const p=require(process.argv[1]);process.stdout.write(p.steps.find(s=>s.key===process.argv[2]).command)' "$PIPE_JSON" "$1"; }

echo "1. the pipeline against ci.yml"
code=0; node "$TOOL/scripts/buildkite/pipeline.mjs" --check --ci-json "$CI_JSON" > "$T/check.log" 2>&1 || code=$?
expect "npm run ci:pipeline --check passes on this branch" '[ $code = 0 ]'
expect "it counts the ci.yml gates it maps" 'grep -q "gate steps run by the pipeline" "$T/check.log"'
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { gateCoverage, buildPipeline, pipelineRules } from '$TOOL/scripts/buildkite/lib.mjs';
const ci = JSON.parse(readFileSync('$CI_JSON', 'utf8'));
const add = structuredClone(ci); add.jobs.check.steps.push({ name: 'A new gate', run: 'npm run new-gate' });
const r1 = gateCoverage(add);
const ren = structuredClone(ci); ren.jobs.check.steps.find((s) => s.name === 'Typecheck').name = 'Types';
const r2 = gateCoverage(ren);
const mx = structuredClone(ci); mx.jobs.e2e.strategy.matrix.browser.push('msedge');
const r3 = gateCoverage(mx);
const p = buildPipeline(ci); p.steps.find((s) => s.key === 'e2e-webkit').agents.queue = 'linux'; p.steps.find((s) => s.key === 'lint').soft_fail = true;
p.steps.find((s) => s.key === 'static').retry = { automatic: [{ exit_status: 1, limit: 2 }] };
const r4 = pipelineRules(p);
console.log(JSON.stringify({ add: r1.problems, ren: r2.problems, mx: r3.problems, rules: r4 }));
" > "$T/neg.json"
expect "a new ci.yml gate the pipeline lacks fails the check" 'grep -q "A new gate" "$T/neg.json"'
expect "a renamed ci.yml step fails the check" 'grep -q "has no step \\\\\"Typecheck\\\\\"" "$T/neg.json"'
expect "a new e2e browser in ci.yml's matrix fails the check" 'grep -q "browser=msedge has no pipeline job" "$T/neg.json"'
expect "WebKit off the Mac, soft_fail and a retry on exit 1 break the rules" 'grep -q "e2e-webkit must run on the Mac" "$T/neg.json" && grep -q "soft_fail" "$T/neg.json" && grep -q "automatic retry on exit 1" "$T/neg.json"'
expect "no single \$ is left for Buildkite to interpolate" 'python3 -I -c "
import yaml,re,sys
p=yaml.safe_load(open(sys.argv[1]))
bad=[s[\"key\"] for s in p[\"steps\"] if re.search(r\"(?<!\\\$)\\\$(?!\\\$)\", s[\"command\"].replace(\"\$\$\",\"\"))]
sys.exit(1 if bad else 0)" "$TOOL/.buildkite/pipeline.yml"'

# ── fakes ──────────────────────────────────────────────────────────────────
mkdir -p "$T/bin" "$T/state"
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
S="$FAKE_STATE"; echo "docker $*" >> "$S/docker.log"
case "$1" in
  image) exit 0 ;;
  run) shift; dir=""; envs=()
       while [ $# -gt 0 ]; do case "$1" in -v) case "$2" in *:/lumen) dir="${2%:/lumen}" ;; esac; shift 2 ;; -e) case "$2" in *=*) envs+=("$2") ;; *) [ -n "${!2+x}" ] && envs+=("$2=${!2}") ;; esac; shift 2 ;; -u|-w) shift 2 ;; --*) shift ;; *) break ;; esac; done
       shift; cd "$dir" && exec env "${envs[@]}" "$@" ;;
  *) echo "fake docker: unhandled $1" >&2; exit 3 ;;
esac
EOF
cat > "$T/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $* LIBGL=${LIBGL_ALWAYS_SOFTWARE:-} CANARY=${COLLAB_TOKEN_SECRET:+set}" >> "$FAKE_STATE/npm.log"
[ "$1" = ci ] && exit 0
for s in ${FAKE_FAIL:-}; do case " $* " in *" $s "*) echo "fake npm: $s fails"; exit 1 ;; esac; done
exit 0
EOF
cat > "$T/bin/npx" <<'EOF'
#!/usr/bin/env bash
echo "npx $* LIBGL=${LIBGL_ALWAYS_SOFTWARE:-} HEADED=${PW_FIREFOX_HEADED:-}" >> "$FAKE_STATE/npx.log"
if [ "$1 $2" = "vitest run" ] && [[ " $* " == *" --merge-reports="* ]]; then node "$FAKE_STATE/vitest-report.mjs"; exit $?; fi
exit 0
EOF
cat > "$T/bin/xvfb-run" <<'EOF'
#!/usr/bin/env bash
echo "xvfb-run $*" >> "$FAKE_STATE/npx.log"; while [ "${1:-}" != npx ]; do shift; done; exec "$@"
EOF
cat > "$T/bin/buildkite-agent" <<'EOF'
#!/usr/bin/env bash
echo "buildkite-agent $*" >> "$FAKE_STATE/agent.log"
case "$1 $2" in
  "step get") k="${@: -1}"; v=$(node -e 'const o=require(process.env.FAKE_STATE+"/outcomes.json");process.stdout.write(o[process.argv[1]]??"")' "$k"); [ -n "$v" ] && echo "$v" || exit 1 ;;
  "meta-data get") echo "2026-11-14T10:00:00Z" ;;
  "annotate "*|annotate*) cat > "$FAKE_STATE/annotation.md" ;;
  "artifact download") exit 0 ;;
  "--version ") echo "buildkite-agent version 3 (fake)" ;;
esac
EOF
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "gh $* GH_TOKEN=${GH_TOKEN:+set}" >> "$FAKE_STATE/gh.log"; echo '{}'
EOF
for t in apt-get systemctl chown launchctl; do printf '#!/usr/bin/env bash\necho "%s $*" >> "$FAKE_STATE/system.log"\n' "$t" > "$T/bin/$t"; done
printf '#!/usr/bin/env bash\necho "curl $*" >> "$FAKE_STATE/system.log"; echo FAKEKEY\n' > "$T/bin/curl"
printf '#!/usr/bin/env bash\necho "gpg $*" >> "$FAKE_STATE/system.log"; out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done; mkdir -p "$(dirname "$out")"; cat > "$out"\n' > "$T/bin/gpg"
chmod +x "$T/bin"/*
export PATH="$T/bin:$PATH" FAKE_STATE="$T/state"

echo "2. the generated job commands, run through run.sh (Docker emulated)"
cd "$TOOL"
code=0; FAKE_FAIL="hygiene" bash -c "$(cmd static)" > "$T/static.log" 2>&1 || code=$?
rows=$(wc -l < ci-out/gates-static.tsv)
expect "static gates: all 10 ci.yml steps ran although hygiene failed (keep going)" '[ "$rows" = 10 ] && grep -q "^Code hygiene.*	1	" ci-out/gates-static.tsv && [ "$(grep -c "	skipped	" ci-out/gates-static.tsv)" = 0 ]'
expect "static gates: the job fails and names the failing gate" '[ $code = 1 ] && grep -q "✗ Code hygiene" "$T/static.log"'
# The drift gate's verdict is this branch's own (real node, real locale files); here it must have run and printed its counts.
expect "static gates: the i18n drift gate ran for real (ci.yml's own script)" 'grep -q "^i18n drift gate	" ci-out/gates-static.tsv && grep -q "i18n keys — en:" "$T/static.log"'
expect "the job ran in Playwright's image for the lockfile's version" 'grep -q "lumen-factory:pw-$(node -p "require(\"./package-lock.json\").packages[\"node_modules/@playwright/test\"].version")" "$T/state/docker.log"'
code=0; FAKE_FAIL="build" bash -c "$(cmd build)" > "$T/build.log" 2>&1 || code=$?
expect "build: a failed build stops the job; the secret and budget checks are reported as not run" '[ $code = 1 ] && [ "$(grep -c "	skipped	" ci-out/gates-build.tsv)" = 3 ]'
expect "build: the build ran with ci.yml's canary secrets set" 'grep -q "npm run build LIBGL= CANARY=set" "$T/state/npm.log"'
: > "$T/state/npx.log"; code=0; bash -c "$(cmd e2e-firefox)" > "$T/ff.log" 2>&1 || code=$?
expect "e2e firefox: under xvfb with software GL, as ci.yml runs it" '[ $code = 0 ] && grep -q "xvfb-run --auto-servernum" "$T/state/npx.log" && grep -q "npx playwright test --project=firefox --reporter=line,github,html LIBGL=1 HEADED=1" "$T/state/npx.log"'
: > "$T/state/npx.log"; code=0; LUMEN_CI_EXEC=native bash -c "$(cmd e2e-webkit)" > "$T/wk.log" 2>&1 || code=$?
expect "e2e webkit (the Mac, native): installs WebKit, then runs the webkit project" '[ $code = 0 ] && grep -q "npx playwright install webkit" "$T/state/npx.log" && grep -q "npx playwright test --project=webkit" "$T/state/npx.log"'

echo "3. vitest shards: plan on the real files, merge, every planned file ran"
node scripts/buildkite/vitest-shards.mjs plan --shards 4 --out ci-out/vitest-shards.json > "$T/plan.log"
expect "the plan puts every test file in exactly one shard" 'node -e "const p=require(\"./ci-out/vitest-shards.json\");const a=p.shards.flatMap(s=>s.files);process.exit(a.length===p.files&&new Set(a).size===a.length&&p.files>100?0:1)"'
cat > "$T/state/vitest-report.mjs" <<EOF
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const plan = JSON.parse(readFileSync("ci-out/vitest-shards.json", "utf8"));
const drop = process.env.FAKE_DROP;
const files = plan.shards.flatMap((s) => s.files).filter((f) => f !== drop);
mkdirSync("ci-out", { recursive: true });
writeFileSync("ci-out/vitest.json", JSON.stringify({ numTotalTests: files.length * 3, numFailedTests: 0, success: true,
  testResults: files.map((f, i) => ({ name: process.cwd() + "/" + f, status: "passed", startTime: 1000, endTime: 1000 + 50 + (i % 7) * 40 })) }));
EOF
mkdir -p .vitest/blob; for i in 1 2 3 4; do echo '{}' > ".vitest/blob/shard-$i.json"; done
code=0; node scripts/buildkite/vitest-shards.mjs merge --plan ci-out/vitest-shards.json > "$T/merge.log" 2>&1 || code=$?
expect "merge: all planned files ran → pass, timings written for the next plan" '[ $code = 0 ] && [ -s ci-out/vitest-timings.json ]'
code=0; FAKE_DROP="src/__tests__/vaultEncryption.test.ts" node scripts/buildkite/vitest-shards.mjs merge --plan ci-out/vitest-shards.json > "$T/merge2.log" 2>&1 || code=$?
expect "merge: a planned file that did not run (a must-run suite) fails" '[ $code = 1 ] && grep -q "did not run" "$T/merge2.log"'
rm -f .vitest/blob/shard-4.json
code=0; node scripts/buildkite/vitest-shards.mjs merge --plan ci-out/vitest-shards.json > "$T/merge3.log" 2>&1 || code=$?
expect "merge: a missing shard report fails" '[ $code = 1 ] && grep -q "shard report(s) missing" "$T/merge3.log"'
node scripts/buildkite/vitest-shards.mjs plan --shards 4 --timings ci-out/vitest-timings.json --out "$T/plan2.json" > "$T/plan2.log"
expect "the next plan balances by the measured times (spread ≤ 25%)" 'node -e "process.exit(require(\"$T/plan2.json\").basis===\"timings\"&&require(\"$T/plan2.json\").spread<=0.25?0:1)"'
for i in 1 2 3 4; do echo '{}' > ".vitest/blob/shard-$i.json"; done
node scripts/buildkite/vitest-shards.mjs merge --plan ci-out/vitest-shards.json > /dev/null 2>&1 || true

echo "4. the signed receipt"
git init -q --bare "$T/receipts.git"; git clone -q "$T/receipts.git" "$T/fh/receipts" 2>/dev/null
echo '{"static":"passed","lint":"passed","licenses":"passed","build":"passed","vitest":"passed","vitest-merge":"passed","e2e-chromium":"passed","e2e-firefox":"passed","e2e-webkit":"hard_failed","e2e-prod":"passed"}' > "$T/state/outcomes.json"
echo "github_pat_fake" > "$T/token"
code=0; BUILDKITE_COMMIT=$(printf 'a%.0s' {1..40}) BUILDKITE_BRANCH=ci/x BUILDKITE_BUILD_NUMBER=7 BUILDKITE_BUILD_URL=https://buildkite.com/o/p/builds/7 LUMEN_CI_PR=512 \
  LUMEN_NIGHTLY_KEY="$T/key.pem" LUMEN_FACTORY_HOME="$T/fh" LUMEN_FACTORY_TOKEN_FILE="$T/token" GIT_SSH_COMMAND=ssh \
  node scripts/buildkite/receipt.mjs --gates static,lint,licenses,build,vitest,vitest-merge,e2e-chromium,e2e-firefox,e2e-webkit,e2e-prod,lighthouse > "$T/receipt.log" 2>&1 || code=$?
expect "receipt: sealed and written" '[ $code = 0 ] && [ -s ci-out/receipt.json ]'
expect "receipt: kind full with the factory's suite names; webkit failed, a gate with no outcome is not a pass" 'node -e "const r=require(\"./ci-out/receipt.json\");process.exit(r.kind===\"full\"&&r.suites.build.ok&&r.suites.vitest.ok&&r.suites[\"e2e webkit\"].ok===false&&r.suites.lighthouse.ok===false&&r.commit.pr===512?0:1)"'
node -e 'const {createPublicKey,createPrivateKey}=require("crypto");const fs=require("fs");fs.writeFileSync(process.argv[2],createPublicKey(createPrivateKey(fs.readFileSync(process.argv[1]))).export({type:"spki",format:"pem"}))' "$T/key.pem" "$T/pub.pem"
expect "receipt: --verify with the public key passes" 'node scripts/buildkite/receipt.mjs --verify ci-out/receipt.json --key "$T/pub.pem" > /dev/null'
sed 's/"passed"/"pas5ed"/' ci-out/receipt.json > "$T/tampered.json"
code=0; node scripts/buildkite/receipt.mjs --verify "$T/tampered.json" --key "$T/pub.pem" > /dev/null 2>&1 || code=$?
expect "receipt: one changed byte fails the check (exit ≠ 0)" '[ $code != 0 ]'
expect "receipt: committed and pushed to the receipts repository as commits/<sha>/full-*.json" 'git --git-dir="$T/receipts.git" log --name-only --format=%s | grep -q "commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/full-"'
expect "receipt: a lumen/receipt status links to it, with the token in the environment only" 'grep -q "context=lumen/receipt" "$T/state/gh.log" && grep -q "GH_TOKEN=set" "$T/state/gh.log" && ! grep -q github_pat_fake "$T/state/gh.log"'
expect "receipt: the build is annotated with the sha256" 'grep -q "$(node -p "require(\"./ci-out/receipt.json\").receipt.sha256")" "$T/state/annotation.md"'

echo "5. the trigger against local GitHub and Buildkite stand-ins"
cat > "$T/api.mjs" <<'EOF'
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const log = process.argv[2];
const old = "2026-11-01T00:00:00Z", fresh = "2099-01-01T00:00:00Z";
const pr = (n, sha, updated, repo = "talstilkol/lumen-md") => ({ number: n, state: "open", title: `feat: thing ${n} [skip ci]`, updated_at: updated, labels: [{ name: "x" }], head: { sha: sha.repeat(40), ref: `b/${n}`, repo: { full_name: repo } }, base: { ref: "main" } });
const pulls = [pr(1, "1", old), pr(2, "2", fresh), pr(3, "3", fresh, "someone/fork"), pr(4, "4", fresh)];
const s = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    appendFileSync(log, `${req.method} ${req.url} auth=${req.headers.authorization ? "yes" : "no"} ${body}\n`);
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/repos/talstilkol/lumen-md/pulls")) return res.end(JSON.stringify(pulls));
    if (req.method === "GET" && req.url.includes("/builds?commit=")) return res.end(req.url.includes("4".repeat(40)) ? JSON.stringify([{ number: 41 }]) : "[]");
    if (req.method === "POST") { res.statusCode = 201; return res.end(JSON.stringify({ number: 99, web_url: "https://buildkite.com/x/99" })); }
    res.statusCode = 404; res.end("{}");
  });
});
s.listen(0, "127.0.0.1", () => writeFileSync(process.argv[3], String(s.address().port)));
EOF
node "$T/api.mjs" "$T/api.log" "$T/port" & API=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
P=$(cat "$T/port"); echo "bkua_fake_token_0123456789" > "$T/bktoken"
TRIG=(env LUMEN_GITHUB_API="http://127.0.0.1:$P" LUMEN_BUILDKITE_API="http://127.0.0.1:$P" LUMEN_BUILDKITE_ORG=lumen LUMEN_BUILDKITE_TOKEN_FILE="$T/bktoken" LUMEN_FACTORY_HOME="$T/trig")
mkdir -p "$T/trig"; echo '{"since":"2026-11-10T00:00:00Z","built":{}}' > "$T/trig/buildkite-trigger.json"
"${TRIG[@]}" node scripts/buildkite/trigger.mjs > "$T/trig1.log" 2>&1 || true
expect "trigger: builds the new same-repository head, through the REST API" 'grep -q "POST /v2/organizations/lumen/pipelines/lumen-md/builds auth=yes" "$T/api.log" && grep -q "\"commit\":\"2222" "$T/api.log"'
expect "trigger: the build message has no [skip ci] (Buildkite would skip it)" 'grep "^POST" "$T/api.log" | grep -q "\"message\":\"#2 feat: thing 2\"" && ! grep "^POST" "$T/api.log" | grep -q "skip ci"'
expect "trigger: never a fork's head, never a PR older than the start, never a commit that already has a build" '! grep "^POST" "$T/api.log" | grep -q -e "\"commit\":\"3333" -e "\"commit\":\"1111" -e "\"commit\":\"4444"'
: > "$T/api.log"; "${TRIG[@]}" node scripts/buildkite/trigger.mjs > "$T/trig2.log" 2>&1 || true
expect "trigger: a second pass builds nothing again" '! grep -q "^POST" "$T/api.log"'
: > "$T/api.log"; "${TRIG[@]}" node scripts/buildkite/trigger.mjs --backfill 5 > "$T/trig3.log" 2>&1 || true
expect "trigger: --backfill builds the older PR too" 'grep "^POST" "$T/api.log" | grep -q "\"commit\":\"1111"'
kill "$API" 2>/dev/null || true

echo "6. agent-bootstrap.sh"
code=0; bash scripts/buildkite/agent-bootstrap.sh --dry-run > "$T/dry.log" 2>&1 || code=$?
expect "Ubuntu dry run: exit 0, every step printed, nothing installed" '[ $code = 0 ] && grep -q "5/5 self-check" "$T/dry.log" && ! grep -q "apt-get" "$T/state/system.log" 2>/dev/null'
R="$T/root"
code=0; printf 'agenttoken_0123456789abcdef\n' | LUMEN_BUILDKITE_ROOT="$R" bash scripts/buildkite/agent-bootstrap.sh --secrets-stdin --no-trigger > "$T/nofac.log" 2>&1 || code=$?
expect "Ubuntu: refuses to install before the factory (no /etc/lumen-factory/env)" '[ $code = 2 ] && grep -q "factory/bootstrap.sh first" "$T/nofac.log"'
mkdir -p "$R/etc/lumen-factory" "$R/srv/lumen-factory/tool/scripts/buildkite"; echo "LUMEN_FACTORY_HOME=/srv/lumen-factory" > "$R/etc/lumen-factory/env"; touch "$R/srv/lumen-factory/tool/scripts/buildkite/trigger.mjs"
code=0; printf 'agenttoken_0123456789abcdef\nbkua_apitoken_0123456789abcdef\n' | LUMEN_BUILDKITE_ROOT="$R" bash scripts/buildkite/agent-bootstrap.sh --secrets-stdin --org lumen > "$T/ub.log" 2>&1 || code=$?
CFG="$R/etc/buildkite-agent/buildkite-agent.cfg"
expect "Ubuntu: installs from Buildkite's signed apt repository" '[ $code = 0 ] && grep -q "keys.openpgp.org/vks/v1/by-fingerprint/32A37959C2FA5C3C99EFBC32A79206696452D198" "$T/state/system.log" && grep -q "apt.buildkite.com/buildkite-agent stable main" "$R/etc/apt/sources.list.d/buildkite-agent.list"'
expect "Ubuntu: agent config 0600 with the token, queue=linux, lumen-md only, no plugins or checkout hooks" '[ "$(stat -c %a "$CFG")" = 600 ] && grep -q "token=\"agenttoken_0123456789abcdef\"" "$CFG" && grep -q "queue=linux,exec=docker" "$CFG" && grep -q "allowed-repositories" "$CFG" && grep -q "no-plugins=true" "$CFG" && grep -q "no-local-hooks=true" "$CFG"'
expect "Ubuntu: runs as the factory user lumen in the docker group" 'grep -q "^User=lumen" "$R/etc/systemd/system/buildkite-agent.service.d/lumen.conf" && grep -q "SupplementaryGroups=docker" "$R/etc/systemd/system/buildkite-agent.service.d/lumen.conf"'
expect "Ubuntu: the trigger timer every 5 minutes, its API token 0600" 'grep -q "OnUnitActiveSec=5min" "$R/etc/systemd/system/lumen-buildkite-trigger.timer" && [ "$(stat -c %a "$R/etc/lumen-factory/buildkite-api-token")" = 600 ] && grep -q "systemctl enable --now lumen-buildkite-trigger.timer" "$T/state/system.log"'
expect "Ubuntu: no token ever on a command line" '! grep -rq -e agenttoken_ -e bkua_apitoken "$T/state/system.log"'
mkdir -p "$T/mac/bin"; printf '#!/usr/bin/env bash\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; *) echo Darwin;; esac\n' > "$T/mac/bin/uname"
printf '#!/usr/bin/env bash\necho "brew $*" >> "$FAKE_STATE/system.log"; [ "$1" = --prefix ] && echo /opt/homebrew; exit 0\n' > "$T/mac/bin/brew"; chmod +x "$T/mac/bin"/*
MR="$T/macroot"; mkdir -p "$MR$HOME/lumen-factory/etc"; echo "LUMEN_FACTORY_EXEC=native" > "$MR$HOME/lumen-factory/etc/env"
code=0; printf 'agenttoken_0123456789abcdef\n' | PATH="$T/mac/bin:$PATH" LUMEN_BUILDKITE_ROOT="$MR" bash scripts/buildkite/agent-bootstrap.sh --secrets-stdin > "$T/mac.log" 2>&1 || code=$?
expect "Mac: queue=mac, native, a LaunchAgent in the user's session, no trigger" '[ $code = 0 ] && grep -q "queue=mac,exec=native" "$MR/opt/homebrew/etc/buildkite-agent/buildkite-agent.cfg" && grep -q "dev.lumen-md.buildkite-agent" "$MR$HOME/Library/LaunchAgents/dev.lumen-md.buildkite-agent.plist" && grep -q "launchctl bootstrap gui/" "$T/state/system.log" && grep -q "trigger: not on this machine" "$T/mac.log"'
expect "Mac: the jobs' environment hook says native" 'grep -q "LUMEN_CI_EXEC=native" "$MR$HOME/lumen-factory/etc/buildkite-hooks/environment"'

rm -rf ci-out .vitest
echo
echo "buildkite selftest: $pass passed, $fail failed"
[ "$fail" = 0 ]
