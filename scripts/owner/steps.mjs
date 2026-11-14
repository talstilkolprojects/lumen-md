/**
 * The owner's three sessions as data (plan W6.20; docs: project/owner-session-command).
 *
 * Each step: what Tal does (`do`, en + he, with the exact page to open),
 * optional `actions` the command runs for him after asking, and `checks`
 * that verify the result. `auto: true` checks ask an API, a file or a
 * command; `auto: false` ones are Tal's yes/no, recorded as attested.
 * A check returns { ok: true | false | null, detail } — null: it could not
 * run (a missing token or tool), so the step stays open.
 *
 * `covers` lists the owner commands, from the open PRs' owner sections, that
 * the step takes care of (scripts/owner/collect.mjs matches them).
 *
 * Step ids are the ones scripts/plan/area-bars.mjs (W6.44) reads.
 */

export const REPO = "talstilkol/lumen-md";
export const SITE = "https://lumen-md.vercel.app";
export const SESSIONS = {
  accounts: { en: "Session 1 — accounts, keys and switches (any computer)", he: "ישיבה 1 — חשבונות, מפתחות ומתגים (כל מחשב)" },
  gpu: { en: "Session 2 — models and data (the cloud GPU, the Mac as fallback)", he: "ישיבה 2 — מודלים ונתונים (GPU בענן, ה-Mac כגיבוי)" },
  devices: { en: "Session 3 — devices, releases and the merge", he: "ישיבה 3 — מכשירים, שחרורים ומיזוג" },
};

// ── helpers the checks share ──
const ok = (cond, yes, no) => ({ ok: Boolean(cond), detail: cond ? yes : no });
const need = (what) => ({ ok: null, detail: `cannot check: ${what}` });
const ghJson = async (ctx, path) => ctx.gh(path);
const merged = (n) => async (ctx) => {
  const r = await ghJson(ctx, `repos/${REPO}/pulls/${n}`);
  if (r.status !== 200) return need(`gh api pulls/${n} → ${r.status}`);
  return ok(r.json?.merged === true, `#${n} merged`, `#${n} is not merged (${r.json?.state ?? "?"})`);
};
const file = (p, what = p) => async (ctx) => ok(ctx.exists(ctx.path(p)), `${what} exists`, `${what} is missing`);
/** Vercel REST with Tal's token: GET https://api.vercel.com<path>?teamId=… */
export const vercel = async (ctx, path, init = {}) => {
  const token = ctx.env.VERCEL_TOKEN;
  if (!token) return { status: 0, json: null, missing: "VERCEL_TOKEN (vercel.com → Account Settings → Tokens)" };
  const team = ctx.env.VERCEL_TEAM_ID ?? "team_Wbm2NUwz3lSO2eEs1YkURQ7M";
  return ctx.fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${team}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
};
const PROJECT = (ctx) => ctx.env.VERCEL_PROJECT ?? "lumen-md";
const vercelEnv = async (ctx) => {
  const r = await vercel(ctx, `/v10/projects/${PROJECT(ctx)}/env`);
  if (r.missing) return { missing: r.missing };
  if (r.status !== 200) return { missing: `Vercel env list → HTTP ${r.status}` };
  return { envs: r.json?.envs ?? [] };
};
const hasEnv = (key, target) => async (ctx) => {
  const r = await vercelEnv(ctx);
  if (r.missing) return need(r.missing);
  const e = r.envs.find((x) => x.key === key && (!target || [].concat(x.target ?? []).includes(target)));
  return ok(e, `${key} is set${target ? ` for ${target}` : ""}`, `${key} is not set${target ? ` for ${target}` : ""} in Vercel`);
};
/** VITE_* names that look like secrets: they end up in the public bundle (15.18). */
export const PUBLIC_VITE = new Set(["VITE_GDRIVE_CLIENT_ID", "VITE_DROPBOX_APP_KEY", "VITE_MODEL_MIRROR_URL", "VITE_SYNC_RELAY_URL", "VITE_SIGNALING_URL"]);
export const secretLooking = (key) => key.startsWith("VITE_") && !PUBLIC_VITE.has(key) && /TOKEN|SECRET|PASSWORD|PRIVATE|_KEY$|API_KEY|DSN/.test(key);
const cmdOk = (cmd, args, test, what) => async (ctx) => {
  if (!ctx.which(cmd)) return need(`${cmd} is not installed`);
  const r = await ctx.exec(cmd, args);
  return ok(r.status === 0 && test(r.stdout ?? ""), what, `${cmd} ${args.join(" ")} → exit ${r.status}: ${String(r.stderr || r.stdout || "").trim().split("\n").slice(-1)[0] ?? ""}`);
};
const http = (url, what, accept = (s) => s === 200) => async (ctx) => {
  const u = typeof url === "function" ? url(ctx) : url;
  if (!u) return need(`no URL for ${what}`);
  const r = await ctx.fetch(u, { method: "GET" });
  return ok(accept(r.status), `${what}: HTTP ${r.status}`, `${what}: HTTP ${r.status} at ${u}`);
};
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
const manual = (id, en, he) => ({ id, auto: false, en, he });

/** @type {Array<{id:string,session:string,minutes:number,plan:string[],prs:number[],en:string,he:string,do:{en:string[],he:string[]},actions?:any[],checks:any[],covers:string[]}>} */
export const STEPS = [
  // ───────────── session 1: accounts ─────────────
  {
    id: "accounts/github",
    session: "accounts",
    minutes: 15,
    plan: ["W6.10", "W6.12", "W4.3", "W4.28"],
    prs: [432, 481, 498],
    en: "Merge #432, turn on GitHub's protections and Vercel's Ignored Build Step",
    he: "למזג את #432, להפעיל את ההגנות של GitHub ואת ה-Ignored Build Step של Vercel",
    do: {
      en: [`Open https://github.com/${REPO}/pull/432 → "Merge pull request" (the live metadata fix, W4.3).`, "Let this command run the four GitHub switches and the Vercel setting below (it asks first).", "Needs `gh auth login` and VERCEL_TOKEN (vercel.com/account/tokens, scope: the lumen-md team)."],
      he: [`לפתוח את https://github.com/${REPO}/pull/432 ← ״Merge pull request״ (תיקון המטא-דאטה, W4.3).`, "לתת לפקודה להריץ את ארבעת המתגים של GitHub ואת הגדרת Vercel שלמטה (היא שואלת קודם).", "צריך `gh auth login` ו-VERCEL_TOKEN ‏(vercel.com/account/tokens, ‏scope: הצוות של lumen-md)."],
    },
    actions: [
      { en: "Create the human-reviewed label", cmd: ["gh", "label", "create", "human-reviewed", "--repo", REPO, "--color", "0E8A16", "--description", "A person reviewed the diff after the last commit (W4.28)"] },
      { en: "Turn on private vulnerability reporting", cmd: ["gh", "api", "-X", "PUT", `repos/${REPO}/private-vulnerability-reporting`] },
      { en: "Turn on secret scanning and push protection", cmd: ["gh", "api", "-X", "PATCH", `repos/${REPO}`, "--input", "-"], stdin: JSON.stringify({ security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } } }) },
      { en: "Set Vercel's Ignored Build Step to scripts/vercel-ignore.sh (W6.10)", fn: async (ctx) => { const r = await vercel(ctx, `/v9/projects/${PROJECT(ctx)}`, { method: "PATCH", body: JSON.stringify({ commandForIgnoringBuildStep: "bash scripts/vercel-ignore.sh" }) }); return r.missing ? need(r.missing) : ok(r.status === 200, "set", `HTTP ${r.status}`); } },
    ],
    checks: [
      { id: "merged-432", auto: true, en: "#432 is merged", he: "‏#432 ממוזג", run: merged(432) },
      { id: "label", auto: true, en: "The human-reviewed label exists", he: "התווית human-reviewed קיימת", run: async (ctx) => { const r = await ghJson(ctx, `repos/${REPO}/labels/human-reviewed`); return ok(r.status === 200, "label exists", `label: HTTP ${r.status}`); } },
      { id: "private-vulnerability-reporting", auto: true, en: "Private vulnerability reporting is on", he: "דיווח פגיעויות פרטי פעיל", run: async (ctx) => { const r = await ghJson(ctx, `repos/${REPO}/private-vulnerability-reporting`); return r.status === 200 ? ok(r.json?.enabled === true, "enabled", "disabled") : need(`HTTP ${r.status}`); } },
      { id: "secret-scanning", auto: true, en: "Secret scanning and push protection are on", he: "סריקת סודות ו-push protection פעילים", run: async (ctx) => { const r = await ghJson(ctx, `repos/${REPO}`); const s = r.json?.security_and_analysis ?? {}; return r.status === 200 ? ok(s.secret_scanning?.status === "enabled" && s.secret_scanning_push_protection?.status === "enabled", "both enabled", `secret_scanning ${s.secret_scanning?.status ?? "?"}, push_protection ${s.secret_scanning_push_protection?.status ?? "?"}`) : need(`HTTP ${r.status}`); } },
      { id: "ignored-build-step", auto: true, en: "Vercel runs scripts/vercel-ignore.sh before each build", he: "‏Vercel מריץ את scripts/vercel-ignore.sh לפני כל בנייה", run: async (ctx) => { const r = await vercel(ctx, `/v9/projects/${PROJECT(ctx)}`); if (r.missing) return need(r.missing); const c = r.json?.commandForIgnoringBuildStep ?? ""; return ok(c.includes("vercel-ignore.sh"), `set: ${c}`, `commandForIgnoringBuildStep is "${c}"`); } },
    ],
    covers: ["gh label create human-reviewed", "private-vulnerability-reporting", "secret_scanning", "Merge \\*\\*#432\\*\\*", "commandForIgnoringBuildStep", "^gh auth login$", "-X PATCH repos/talstilkol/lumen-md --input"],
  },
  {
    id: "accounts/vercel-hf",
    session: "accounts",
    minutes: 15,
    plan: ["15.18", "15.9", "15.11"],
    prs: [243, 486],
    en: "Leaked VITE_ keys, the Hugging Face token and seed, dataset terms",
    he: "מפתחות VITE_ שדלפו, הטוקן והזרע של Hugging Face, תנאי הנתונים",
    do: {
      en: ["The command lists every VITE_* variable in Vercel whose name looks secret (15.18). For each one: revoke it at its provider, create a new one, and store it without the VITE_ prefix (`vercel env add <NAME> production`).", "huggingface.co/settings/tokens → New token (read) → `vercel env add HF_TOKEN preview`, and keep it in your shell as HF_TOKEN for the next check.", "`openssl rand -hex 32 | vercel env add GOLDEN_SEED preview`", "Logged in to Hugging Face: https://huggingface.co/datasets/openlanguagedata/flores_plus → accept the terms. Accept Common Voice's terms where 7.1's download fetches it."],
      he: ["הפקודה מציגה כל משתנה VITE_* ב-Vercel ששמו נראה סודי (15.18). לכל אחד: לבטל אותו אצל הספק, ליצור חדש, ולשמור אותו בלי הקידומת VITE_ ‏(`vercel env add <NAME> production`).", "huggingface.co/settings/tokens ← New token ‏(read) ← `vercel env add HF_TOKEN preview`, ולהשאיר אותו במעטפת כ-HF_TOKEN לבדיקה הבאה.", "`openssl rand -hex 32 | vercel env add GOLDEN_SEED preview`", "מחובר ל-Hugging Face: ‏https://huggingface.co/datasets/openlanguagedata/flores_plus ← לאשר את התנאים. לאשר את התנאים של Common Voice במקום שממנו ההורדה של 7.1 מושכת אותו."],
    },
    checks: [
      { id: "no-secret-vite", auto: true, en: "No secret-looking VITE_* variable in Vercel", he: "אין ב-Vercel משתנה VITE_* שנראה סודי", run: async (ctx) => { const r = await vercelEnv(ctx); if (r.missing) return need(r.missing); const bad = [...new Set(r.envs.map((e) => e.key).filter(secretLooking))]; return ok(!bad.length, `${r.envs.length} variables, none secret-looking`, `rotate and rename: ${bad.join(", ")}`); } },
      { id: "hf-token", auto: true, en: "HF_TOKEN is set for preview", he: "‏HF_TOKEN מוגדר ל-preview", run: hasEnv("HF_TOKEN", "preview") },
      { id: "golden-seed", auto: true, en: "GOLDEN_SEED is set for preview", he: "‏GOLDEN_SEED מוגדר ל-preview", run: hasEnv("GOLDEN_SEED", "preview") },
      { id: "flores-terms", auto: true, en: "FLORES+ terms accepted (a gated file downloads with HF_TOKEN)", he: "התנאים של FLORES+ אושרו (קובץ מוגן יורד עם HF_TOKEN)", run: async (ctx) => { if (!ctx.env.HF_TOKEN) return need("HF_TOKEN in this shell"); const r = await ctx.fetch("https://huggingface.co/datasets/openlanguagedata/flores_plus/resolve/main/README.md", { method: "HEAD", headers: { Authorization: `Bearer ${ctx.env.HF_TOKEN}` } }); return ok(r.status === 200 || r.status === 302, `HTTP ${r.status}`, `HTTP ${r.status}: the terms are not accepted for this token's account`); } },
      manual("common-voice-terms", "Common Voice terms accepted", "התנאים של Common Voice אושרו"),
    ],
    covers: ["vercel(@latest)? env ls", "netlify env:list", "vercel env add HF_TOKEN", "GOLDEN_SEED", "flores_plus", "^openssl rand -hex 32$", "FLORES\\+ and Common Voice"],
  },
  {
    id: "accounts/signing",
    session: "accounts",
    minutes: 20,
    plan: ["15.7", "W4.5", "W6.43"],
    prs: [492, 493],
    en: "Signing accounts and keys (store verification takes days: start it now)",
    he: "חשבונות ומפתחות חתימה (אימות החנויות לוקח ימים: להתחיל עכשיו)",
    do: {
      en: ["developer.apple.com/programs/enroll ($99/yr, as an individual).", "play.google.com/console/signup ($25 once, identity check).", "Windows: apply to SignPath's free code signing for open source (signpath.org), or Azure Trusted Signing.", "App Store Connect → Users and Access → Integrations → App Store Connect API → + (Admin) → download AuthKey_<id>.p8 into ~/.lumen-ios/.", "Let this command make the updater key, the release key and the Android upload keystore (it asks first). Keep each private key and its password in your password manager."],
      he: ["‏developer.apple.com/programs/enroll ‏(99$ לשנה, כאדם פרטי).", "‏play.google.com/console/signup ‏(25$ פעם אחת, אימות זהות).", "‏Windows: בקשה לחתימת קוד חינמית לקוד פתוח של SignPath ‏(signpath.org), או Azure Trusted Signing.", "‏App Store Connect ← Users and Access ← Integrations ← App Store Connect API ← + ‏(Admin) ← להוריד את AuthKey_<id>.p8 לתיקייה ~/.lumen-ios/.", "לתת לפקודה ליצור את מפתח העדכונים, מפתח השחרור ו-keystore ההעלאה של Android (היא שואלת קודם). כל מפתח פרטי והסיסמה שלו נשמרים במנהל הסיסמאות."],
    },
    actions: [
      { en: "Make the updater key (~/.tauri/lumen-updater.key)", cmd: ["npx", "tauri", "signer", "generate", "-w", "~/.tauri/lumen-updater.key"], unless: "~/.tauri/lumen-updater.key" },
      { en: "Make the release key (~/.lumen-release, W1.27)", cmd: ["node", "scripts/supply-chain/keys.mjs", "--out", "~/.lumen-release"], unless: "~/.lumen-release/lumen-release.key", needsFile: "scripts/supply-chain/keys.mjs" },
      { en: "Make the Android upload keystore", cmd: ["keytool", "-genkeypair", "-v", "-keystore", "~/.lumen-android/upload.jks", "-alias", "lumen", "-keyalg", "RSA", "-keysize", "4096", "-validity", "10000"], unless: "~/.lumen-android/upload.jks" },
    ],
    checks: [
      { id: "updater-key", auto: true, en: "Updater key pair exists", he: "זוג מפתחות העדכון קיים", run: async (ctx) => ok(ctx.exists(ctx.path("~/.tauri/lumen-updater.key")) && ctx.exists(ctx.path("~/.tauri/lumen-updater.key.pub")), "~/.tauri/lumen-updater.key{,.pub}", "~/.tauri/lumen-updater.key or .pub is missing") },
      { id: "release-key", auto: true, en: "Release key exists", he: "מפתח השחרור קיים", run: file("~/.lumen-release/lumen-release.key") },
      { id: "android-keystore", auto: true, en: "Android upload keystore exists", he: "‏keystore ההעלאה של Android קיים", run: file("~/.lumen-android/upload.jks") },
      { id: "asc-key", auto: true, en: "App Store Connect API key downloaded", he: "מפתח ה-API של App Store Connect הורד", run: async (ctx) => ok(ctx.list(ctx.path("~/.lumen-ios")).some((f) => /^AuthKey_.+\.p8$/.test(f)), "AuthKey_*.p8 found", "no ~/.lumen-ios/AuthKey_*.p8") },
      manual("apple-enrolled", "Apple Developer Program enrolment submitted", "ההרשמה ל-Apple Developer Program נשלחה"),
      manual("play-console", "Google Play Console account created", "חשבון Google Play Console נוצר"),
      manual("windows-signing", "Windows signing applied for (SignPath or Azure)", "בקשה לחתימת Windows נשלחה (SignPath או Azure)"),
    ],
    covers: ["tauri signer generate", "keytool -genkeypair", "supply-chain/keys\\.mjs", "App Store Connect", "updater-key\\.pub", "release-key\\.pub"],
  },
  {
    id: "accounts/test-clouds",
    session: "accounts",
    minutes: 15,
    plan: ["W6.6", "W6.18", "15.12"],
    prs: [504, 510],
    en: "Free test clouds: BrowserStack (Safari, iOS), Firebase Test Lab (Android), Kaggle (GPU)",
    he: "עננים חינמיים לבדיקות: BrowserStack ‏(Safari, ‏iOS), ‏Firebase Test Lab ‏(Android), ‏Kaggle ‏(GPU)",
    do: {
      en: [`browserstack.com/open-source → apply with https://github.com/${REPO} (MIT). When approved: export BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY here, and install them on the factory as #510 says.`, "console.firebase.google.com → Add project → lumen-md-test (Spark, no cost); then `gcloud auth login && gcloud config set project lumen-md-test`.", "kaggle.com → Settings → Phone verification; Settings → API → Create New Token → save kaggle.json as ~/.kaggle/kaggle.json (chmod 600)."],
      he: [`‏browserstack.com/open-source ← בקשה עם https://github.com/${REPO} ‏(MIT). כשמאושר: export ל-BROWSERSTACK_USERNAME ול-BROWSERSTACK_ACCESS_KEY כאן, ולהתקין אותם במפעל כמו ש-#510 אומר.`, "‏console.firebase.google.com ← Add project ← lumen-md-test ‏(Spark, בחינם); ואז `gcloud auth login && gcloud config set project lumen-md-test`.", "‏kaggle.com ← Settings ← Phone verification; ‏Settings ← API ← Create New Token ← לשמור את kaggle.json בתור ~/.kaggle/kaggle.json ‏(chmod 600)."],
    },
    checks: [
      { id: "browserstack", auto: true, en: "BrowserStack Automate answers with these keys", he: "‏BrowserStack Automate עונה עם המפתחות האלה", run: async (ctx) => { const u = ctx.env.BROWSERSTACK_USERNAME; const k = ctx.env.BROWSERSTACK_ACCESS_KEY; if (!u || !k) return need("BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY"); const r = await ctx.fetch("https://api.browserstack.com/automate/plan.json", { headers: { Authorization: basic(u, k) } }); return ok(r.status === 200, `plan: ${r.json?.automate_plan ?? "ok"}`, `HTTP ${r.status}`); } },
      { id: "firebase", auto: true, en: "Firebase Test Lab is reachable with gcloud", he: "‏Firebase Test Lab נגיש דרך gcloud", run: cmdOk("gcloud", ["firebase", "test", "android", "models", "list", "--format=value(MODEL_ID)", "--limit=1"], (o) => o.trim().length > 0, "a device model is listed") },
      { id: "kaggle", auto: true, en: "Kaggle token works", he: "הטוקן של Kaggle עובד", run: async (ctx) => { let u = ctx.env.KAGGLE_USERNAME; let k = ctx.env.KAGGLE_KEY; const f = ctx.path(`${ctx.env.KAGGLE_CONFIG_DIR ?? "~/.kaggle"}/kaggle.json`); if (!u && ctx.exists(f)) { try { ({ username: u, key: k } = JSON.parse(ctx.read(f))); } catch { return ok(false, "", `${f} is not JSON`); } if ((ctx.mode(f) & 0o077) !== 0) return ok(false, "", `${f} is readable by others: chmod 600 it`); } if (!u || !k) return need("~/.kaggle/kaggle.json or KAGGLE_USERNAME + KAGGLE_KEY"); const r = await ctx.fetch("https://www.kaggle.com/api/v1/kernels/list?pageSize=1&mine=true", { headers: { Authorization: basic(u, k) } }); return ok(r.status === 200, `token of ${u} accepted`, `HTTP ${r.status} for ${u}`); } },
    ],
    covers: ["browserstack", "BROWSERSTACK_", "firebase projects:create", "kaggle\\.com", "pip install kaggle", "models:cloud -- setup", "BSU|BSK|Automate Username"],
  },
  {
    id: "accounts/hosts",
    session: "accounts",
    minutes: 20,
    plan: ["15.4", "W4.27", "W6.23", "W6.33"],
    prs: [484, 476, 483],
    en: "Hosts: Cloudflare Pages + the model mirror, Fly signaling + the relay",
    he: "מארחים: ‏Cloudflare Pages והמראה של המודלים, ‏Fly לשרת האיתות ול-relay",
    do: {
      en: ["dash.cloudflare.com → sign up (free). Then let this command run `wrangler login` and create the Pages project (it asks).", "From a checkout with #484: `npm ci && bash scripts/pages-deploy.sh --prod` → https://lumen-md.pages.dev", "With #476: `cd edge-workers/model-mirror && npx wrangler@4 deploy` (set account_id), then `vercel env add VITE_MODEL_MIRROR_URL production` = the worker's URL.", "fly.io → sign up; `cd sync-server && fly launch --copy-config --no-deploy --name lumen-signal && fly deploy`; then `fly secrets set VAULT_RELAY=1 VAULT_RELAY_DIR=/data && fly deploy`; `vercel env add VITE_SYNC_RELAY_URL production` = https://lumen-signal.fly.dev"],
      he: ["‏dash.cloudflare.com ← הרשמה (חינם). אחר כך לתת לפקודה להריץ `wrangler login` וליצור את פרויקט ה-Pages (היא שואלת).", "מ-checkout עם #484: ‏`npm ci && bash scripts/pages-deploy.sh --prod` ← https://lumen-md.pages.dev", "עם #476: ‏`cd edge-workers/model-mirror && npx wrangler@4 deploy` (להגדיר account_id), ואז `vercel env add VITE_MODEL_MIRROR_URL production` = הכתובת של ה-worker.", "‏fly.io ← הרשמה; ‏`cd sync-server && fly launch --copy-config --no-deploy --name lumen-signal && fly deploy`; ואז `fly secrets set VAULT_RELAY=1 VAULT_RELAY_DIR=/data && fly deploy`; ‏`vercel env add VITE_SYNC_RELAY_URL production` = https://lumen-signal.fly.dev"],
    },
    actions: [
      { en: "Log in to Cloudflare", cmd: ["npx", "wrangler@4", "login"] },
      { en: "Create the Pages project lumen-md", cmd: ["npx", "wrangler@4", "pages", "project", "create", "lumen-md", "--production-branch", "main"] },
    ],
    checks: [
      { id: "wrangler", auto: true, en: "wrangler is logged in", he: "‏wrangler מחובר", run: cmdOk("npx", ["wrangler@4", "whoami"], (o) => !/not authenticated|You are not logged in/i.test(o), "logged in") },
      { id: "pages-project", auto: true, en: "The Pages project lumen-md exists", he: "פרויקט ה-Pages ‏lumen-md קיים", run: cmdOk("npx", ["wrangler@4", "pages", "project", "list"], (o) => /\blumen-md\b/.test(o), "lumen-md listed") },
      { id: "pages-live", auto: true, en: "https://lumen-md.pages.dev serves the app", he: "‏https://lumen-md.pages.dev מגיש את האפליקציה", run: http("https://lumen-md.pages.dev/", "pages.dev") },
      { id: "mirror-env", auto: true, en: "VITE_MODEL_MIRROR_URL is set for production", he: "‏VITE_MODEL_MIRROR_URL מוגדר ל-production", run: hasEnv("VITE_MODEL_MIRROR_URL", "production") },
      { id: "signaling", auto: true, en: "The signaling server answers /healthz", he: "שרת האיתות עונה ב-/healthz", run: http((ctx) => `${ctx.env.LUMEN_SIGNAL_URL ?? "https://lumen-signal.fly.dev"}/healthz`, "signaling /healthz") },
      { id: "relay-env", auto: true, en: "VITE_SYNC_RELAY_URL is set for production", he: "‏VITE_SYNC_RELAY_URL מוגדר ל-production", run: hasEnv("VITE_SYNC_RELAY_URL", "production") },
    ],
    covers: ["wrangler(@4)? login", "pages project create", "pages-deploy|pages:deploy", "model-mirror && npx wrangler", "VITE_MODEL_MIRROR_URL", "fly (launch|deploy|secrets)", "VAULT_RELAY", "VITE_SYNC_RELAY_URL", "lumen-md\\.pages\\.dev", "chore/second-host", "collab:deploy|collab-latency|VITE_YJS_WEBSOCKET_URL|COLLAB_TOKEN"],
  },
  {
    id: "accounts/factory",
    session: "accounts",
    minutes: 25,
    plan: ["W6.5", "W6.6"],
    prs: [509, 510],
    en: "The verification factory on Oracle's free VM",
    he: "מפעל האימות על ה-VM החינמי של Oracle",
    do: {
      en: ["cloud.oracle.com → sign up (Always Free). Pick the home region carefully: the Ampere shape exists only there.", "Compute → Instances → Create: Canonical Ubuntu 24.04 (aarch64), VM.Standard.A1.Flex, 2 OCPU, 12 GB, 100 GB boot volume, public IPv4, your SSH key.", `github.com/settings/personal-access-tokens/new → "lumen-factory": only ${REPO}, Commit statuses: Read and write, 1 year.`, "Paste the block in docs self-hosting/verification-factory (#509) on the Mac. Then `export LUMEN_FACTORY_VM=ubuntu@<ip>` here for the checks."],
      he: ["‏cloud.oracle.com ← הרשמה (Always Free). לבחור את אזור הבית בזהירות: צורת Ampere קיימת רק שם.", "‏Compute ← Instances ← Create: ‏Canonical Ubuntu 24.04 ‏(aarch64), ‏VM.Standard.A1.Flex, ‏2 OCPU, ‏12 GB, דיסק אתחול 100 GB, ‏IPv4 ציבורי, מפתח ה-SSH שלך.", `‏github.com/settings/personal-access-tokens/new ← ״lumen-factory״: רק ${REPO}, ‏Commit statuses: Read and write, שנה.`, "להדביק ב-Mac את הבלוק מעמוד התיעוד self-hosting/verification-factory ‏(#509). ואז `export LUMEN_FACTORY_VM=ubuntu@<ip>` כאן בשביל הבדיקות."],
    },
    checks: [
      { id: "vm-timer", auto: true, en: "The VM's nightly timer is active (ssh, or oci when ssh is not set up)", he: "הטיימר הלילי ב-VM פעיל (ssh, או oci כשאין ssh)", run: async (ctx) => {
        const vm = ctx.env.LUMEN_FACTORY_VM;
        if (vm && ctx.which("ssh")) { const r = await ctx.exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", vm, "systemctl", "is-active", "lumen-factory.timer"]); return ok(r.status === 0 && /^active/m.test(r.stdout ?? ""), `${vm}: lumen-factory.timer active`, `${vm}: ${String(r.stdout || r.stderr || "").trim() || `exit ${r.status}`}`); }
        if (ctx.which("oci") && ctx.env.OCI_COMPARTMENT) { const r = await ctx.exec("oci", ["compute", "instance", "list", "--compartment-id", ctx.env.OCI_COMPARTMENT, "--lifecycle-state", "RUNNING", "--all"]); let n = 0; try { n = (JSON.parse(r.stdout).data ?? []).filter((i) => i.shape === "VM.Standard.A1.Flex").length; } catch { /* why: not JSON → n stays 0 */ } return ok(n > 0, `${n} running A1 instance(s) (the timer itself needs ssh)`, "no running VM.Standard.A1.Flex instance"); }
        return need("LUMEN_FACTORY_VM (ssh) or OCI_COMPARTMENT with the oci CLI");
      } },
      { id: "receipts-repo", auto: true, en: "talstilkol/lumen-md-receipts exists with a host key", he: "‏talstilkol/lumen-md-receipts קיים עם מפתח מארח", run: async (ctx) => { const r = await ghJson(ctx, "repos/talstilkol/lumen-md-receipts/contents/keys"); return r.status === 200 ? ok((r.json ?? []).some((f) => String(f.name).endsWith(".pem")), "keys/*.pem published", "no keys/*.pem yet (the first night writes it)") : ok(false, "", `the receipts repository: HTTP ${r.status}`); } },
      { id: "first-status", auto: true, en: "A lumen/factory commit status exists on verify/train-2 (after the first night)", he: "יש commit status של lumen/factory על verify/train-2 (אחרי הלילה הראשון)", run: async (ctx) => { const r = await ghJson(ctx, `repos/${REPO}/commits/verify/train-2/statuses?per_page=100`); return r.status === 200 ? ok((r.json ?? []).some((s) => String(s.context).startsWith("lumen/factory")), "the factory reported", "no lumen/factory status yet: rerun this step after the first night") : need(`HTTP ${r.status}`); } },
    ],
    covers: ["lumen-md-receipts", "lumen-bootstrap|factory/bootstrap", "ssh-keygen -q -t ed25519", "deploy-key add", "browserstack\\.env", "VM=ubuntu@|github_pat_|lumen-factory-key|unset TOKEN"],
  },
  // ───────────── session 2: gpu ─────────────
  {
    id: "gpu/models-day",
    session: "gpu",
    minutes: 20,
    plan: ["W6.18", "15.3", "15.14", "15.17", "W4.6", "W6.17"],
    prs: [504, 503, 443, 449, 454, 458, 379, 421],
    en: "The real models day on Kaggle's free GPU (the Mac only as fallback), with the held-out sets",
    he: "יום המודלים האמיתי על ה-GPU החינמי של Kaggle (ה-Mac רק כגיבוי), עם הסטים המוחזקים",
    do: {
      en: ["Once: `npm run heldout -- keygen` (#503) and keep ~/.config/lumen-heldout/key in your password manager; `pip install -r scripts/golden/requirements.txt && npm run heldout -- build --record`.", "From a checkout with #504: `npm run models:cloud -- --ref <branch with the evals> --push`. It runs unattended (≈ 2 h) and pushes eval/day-<run>.", "Fallback on the GPU Mac (WebGPU-only parts): `npm ci && npm run models:day -- check && npm run models:day`, then push the run folder as it prints."],
      he: ["פעם אחת: ‏`npm run heldout -- keygen` ‏(#503) ולשמור את ~/.config/lumen-heldout/key במנהל הסיסמאות; ‏`pip install -r scripts/golden/requirements.txt && npm run heldout -- build --record`.", "מ-checkout עם #504: ‏`npm run models:cloud -- --ref <branch with the evals> --push`. זה רץ לבד (≈ שעתיים) ודוחף את eval/day-<run>.", "גיבוי על ה-Mac עם ה-GPU (רק מה שדורש WebGPU): ‏`npm ci && npm run models:day -- check && npm run models:day`, ואז לדחוף את תיקיית הריצה כמו שהיא מדפיסה."],
    },
    checks: [
      { id: "heldout-key", auto: true, en: "The held-out key exists", he: "המפתח של הסט המוחזק קיים", run: file("~/.config/lumen-heldout/key") },
      { id: "eval-branch", auto: true, en: "An eval/day-* branch was pushed", he: "ענף eval/day-* נדחף", run: async (ctx) => { const r = await ghJson(ctx, `repos/${REPO}/git/matching-refs/heads/eval/day-`); return r.status === 200 ? ok((r.json ?? []).length > 0, `${(r.json ?? []).length} run(s): ${(r.json ?? []).map((x) => x.ref.replace("refs/heads/", "")).slice(-1)[0] ?? ""}`, "no eval/day-* branch yet") : need(`HTTP ${r.status}`); } },
    ],
    covers: ["models:day|models-day", "models:cloud", "heldout -- (keygen|build)", "eval/heldout", "golden/requirements", "eval:tool-calls", "eval:asr-web|fleurs_spike", "eval:voice-commands", "ollama pull", "dictalm3", "eval:lit-review|LUMEN_EVAL_LIT", "eval:canvas-draw|canvas-draw-eval", "bench:models", "eval:crosslingual", "whisper:desktop|whisper-desktop|whisper-cpp", "diarization-pin|der\\.mjs|RTF", "mlc_llm|optimum-cli", "models:mirror", "eval/day-", "whisper|ivrit-ai|Install on the Mac", "\\.onnx", "dicta-il", "models/registry\\.json", "^shasum "],
  },
  {
    id: "gpu/golden",
    session: "gpu",
    minutes: 60,
    plan: ["15.11", "15.15", "W6.17"],
    prs: [398, 458, 388, 391],
    en: "Your part of the golden sets (an hour now, the rest over days)",
    he: "החלק שלך בסטי הזהב (שעה עכשיו, והשאר על פני כמה ימים)",
    do: {
      en: ["Set LUMEN_GOLDEN_DIR to your golden folder.", "Record the 20 voice clips with CC0 consent (`npm run eval:voice-commands -- --script > commands.json` lists them; they also serve #398's meetings) into $LUMEN_GOLDEN_DIR/voice.", "Then, over the next days: 60 niqqud sentences + 50 error pairs proofread, 20 image descriptions, 30 personal queries, 30 Hebrew injection attacks, 15 photographed pages, 50 translations rated, and 15.15's rating sheet (1–5 per image)."],
      he: ["להגדיר את LUMEN_GOLDEN_DIR לתיקיית הזהב שלך.", "להקליט את 20 קטעי הקול עם הסכמת CC0 ‏(`npm run eval:voice-commands -- --script > commands.json` מפרט אותם; הם משמשים גם לפגישות של #398) לתוך $LUMEN_GOLDEN_DIR/voice.", "ואז, בימים הבאים: ‏60 משפטי ניקוד ו-50 זוגות שגיאה מוגהים, ‏20 תיאורי תמונות, ‏30 שאילתות אישיות, ‏30 התקפות injection בעברית, ‏15 עמודים מצולמים, ‏50 תרגומים מדורגים, ודף הדירוג של 15.15 ‏(1–5 לכל תמונה)."],
    },
    checks: [
      { id: "recordings", auto: true, en: "≥ 20 recordings in $LUMEN_GOLDEN_DIR/voice", he: "‏≥ 20 הקלטות ב-$LUMEN_GOLDEN_DIR/voice", run: async (ctx) => { const d = ctx.env.LUMEN_GOLDEN_DIR; if (!d) return need("LUMEN_GOLDEN_DIR"); const n = ctx.list(ctx.path(`${d}/voice`)).filter((f) => /\.(wav|m4a|ogg|flac|webm|mp3)$/i.test(f)).length; return ok(n >= 20, `${n} recordings`, `${n}/20 recordings`); } },
      manual("text-sets", "Niqqud, error pairs, queries, attacks and translations done", "ניקוד, זוגות שגיאה, שאילתות, התקפות ותרגומים הושלמו"),
      manual("image-ratings", "15.15: the 50 image descriptions rated", "‏15.15: ‏50 תיאורי התמונות דורגו"),
    ],
    covers: ["tts:mos|tts-mos", "LUMEN_EPUB_GOLDEN|epub-golden", "golden recordings|\\.rttm"],
  },
  {
    id: "gpu/archives",
    session: "gpu",
    minutes: 30,
    plan: ["W5.7", "W5.18"],
    prs: [482, 478, 485, 408, 411],
    en: "Your own archives and libraries: mail, chats, Zotero",
    he: "הארכיונים והספריות שלך: דואר, שיחות, Zotero",
    do: {
      en: ["~50 old Hebrew .eml (windows-1255 / ISO-8859-8) + a Gmail Takeout → ⌘K Import mail…; time a 5,000+ message mbox in Chrome.", "10 chats (WhatsApp Android + iPhone, Telegram JSON) → ⌘K Import a WhatsApp or Telegram chat…; compare the counts.", "zotero.org → Settings → Security → Applications → a read-only key → ⌘K Citations: sync the Zotero library from zotero.org; change one item and sync again (toast: 1 changed).", "Send redacted first lines of anything misread: they become fixtures.", "For the check: export ZOTERO_API_KEY=<the read-only key>."],
      he: ["כ-50 קובצי ‎.eml ישנים בעברית (windows-1255 / ISO-8859-8) ו-Gmail Takeout ← ⌘K ייבוא דואר…; למדוד mbox של 5,000+ הודעות ב-Chrome.", "‏10 שיחות (WhatsApp ב-Android וב-iPhone, ‏Telegram JSON) ← ⌘K ייבוא שיחת WhatsApp או Telegram…; להשוות את הספירות.", "‏zotero.org ← Settings ← Security ← Applications ← מפתח לקריאה בלבד ← ⌘K ציטוטים: סנכרון ספריית Zotero מ-zotero.org; לשנות פריט אחד ולסנכרן שוב (הודעה: 1 השתנה).", "לשלוח שורות ראשונות מושחרות של כל מה שנקרא לא נכון: הן הופכות ל-fixtures.", "לבדיקה: ‏export ZOTERO_API_KEY=<המפתח לקריאה בלבד>."],
    },
    checks: [
      { id: "zotero-key", auto: true, en: "The Zotero web API key is valid", he: "מפתח ה-API של Zotero תקף", run: async (ctx) => { const k = ctx.env.ZOTERO_API_KEY; if (!k) return need("ZOTERO_API_KEY (the read-only key from zotero.org)"); const r = await ctx.fetch(`https://api.zotero.org/keys/${encodeURIComponent(k)}`, { headers: { "Zotero-API-Version": "3" } }); return ok(r.status === 200 && r.json?.userID, `key of user ${r.json?.userID ?? "?"}`, `HTTP ${r.status}`); } },
      manual("mail", "Mail import read correctly", "ייבוא הדואר נקרא נכון"), manual("chats", "Chat imports match their counts", "ייבוא השיחות תואם לספירות"), manual("zotero", "Zotero sync: 1 changed after one edit", "סנכרון Zotero: ‏1 השתנה אחרי עריכה אחת")],
    covers: ["Import mail|\\.eml|mbox|Takeout", "WhatsApp|Telegram", "zotero\\.org|Zotero 7|zotero_local", "api\\.zotero\\.org"],
  },
  {
    id: "gpu/cargo-zip",
    session: "gpu",
    minutes: 20,
    plan: ["W6.14"],
    prs: [494, 499],
    en: "The critical Cargo zip advisory and the npm updates that need a real install (on the Mac)",
    he: "הייעוץ הקריטי של zip ב-Cargo ועדכוני npm שדורשים התקנה אמיתית (ב-Mac)",
    do: {
      en: ["On the branch of #499: `cd src-tauri && cargo update -p tauri-plugin-updater --precise 2.14.1 && cargo update -p tauri -p tauri-build -p tauri-plugin-dialog && cargo build && cargo audit`.", "Set zip to \"status\": \"fixed\" in security/known-bad.json, then run #499's lock checks (`npm ci && npm audit --omit=dev` …) and commit with [skip ci]."],
      he: ["על הענף של #499: ‏`cd src-tauri && cargo update -p tauri-plugin-updater --precise 2.14.1 && cargo update -p tauri -p tauri-build -p tauri-plugin-dialog && cargo build && cargo audit`.", "לשנות את zip ל-\"status\": \"fixed\" ב-security/known-bad.json, להריץ את בדיקות הנעילה של #499 ‏(`npm ci && npm audit --omit=dev` …) ולבצע commit עם [skip ci]."],
    },
    checks: [
      { id: "zip-9", auto: true, en: "cargo tree shows zip 9", he: "‏cargo tree מראה zip 9", run: cmdOk("cargo", ["tree", "-i", "zip", "--manifest-path", "src-tauri/Cargo.toml", "--depth", "0"], (o) => /zip v9\./.test(o), "zip v9") },
      { id: "known-bad", auto: true, en: "security/known-bad.json marks zip fixed", he: "‏security/known-bad.json מסמן את zip כמתוקן", run: async (ctx) => { const p = ctx.path("security/known-bad.json"); if (!ctx.exists(p)) return need("security/known-bad.json (on #494's branch)"); const t = ctx.read(p); return ok(/"zip"[\s\S]{0,400}?"status"\s*:\s*"fixed"/.test(t), "fixed", "zip is not marked fixed"); } },
    ],
    covers: ["cargo update", "cargo tree -i zip", "known-bad", "npm (--prefix \\S+ )?(update|audit|install)", "isomorphic-git@|@playwright/test@|astro@|@y/websocket-server", "overrides\\.serialize-javascript", "body-parser", "npm install --no-save ts-fsrs|fsrs-golden", "lexicon:build|hewiktionary|public/lexicon", "PR's locks|Real install|mcp-server", "npm (dedupe|outdated)", "hash-wasm"],
  },
  // ───────────── session 3: devices ─────────────
  {
    id: "devices/manual-checks",
    session: "devices",
    minutes: 60,
    plan: ["15.12", "W2.8", "W4.21", "W1.23", "15.13"],
    prs: [510, 263, 425, 478, 376, 467],
    en: "What only eyes and hands can check: Safari, Word, the phone, screen readers",
    he: "מה שרק עיניים וידיים בודקות: ‏Safari, ‏Word, הטלפון, קוראי מסך",
    do: {
      en: [`BrowserStack Live: Safari on macOS and on an iPhone, ${SITE}, the 15.12 checklist with the Hebrew input source (W2.8). #510's sealed run covers the automatic part.`, "Open the .docx exported by #263 in Word: direction, lists, tables.", "Phone: the widget and Siri (#425), the share sheet → inbox.md (#478), long-press → Voice note under 1 s (#376), a vault in the Files app (4.20), LAN sync between two devices (W2.19).", "Screen readers: the Guidepup commands of #467 with VoiceOver (Mac) and NVDA (Windows); TalkBack on the phone."],
      he: [`‏BrowserStack Live: ‏Safari ב-macOS וב-iPhone, ‏${SITE}, רשימת 15.12 עם מקור הקלט העברי (W2.8). הריצה החתומה של #510 מכסה את החלק האוטומטי.`, "לפתוח ב-Word את קובץ ה-.docx ש-#263 מייצא: כיוון, רשימות, טבלאות.", "טלפון: הווידג׳ט ו-Siri ‏(#425), ‏share sheet ← inbox.md ‏(#478), לחיצה ארוכה ← הערה קולית בפחות משנייה (#376), כספת באפליקציית הקבצים (4.20), סנכרון ברשת המקומית בין שני מכשירים (W2.19).", "קוראי מסך: פקודות Guidepup של #467 עם VoiceOver ‏(Mac) ו-NVDA ‏(Windows); ‏TalkBack בטלפון."],
    },
    checks: [
      { id: "safari-receipt", auto: true, en: "A sealed Safari receipt exists (#510)", he: "קיימת קבלת Safari חתומה (#510)", run: async (ctx) => { const fs = ctx.list(ctx.path("reports/safari")).filter((f) => f.endsWith(".json")); return ok(fs.length > 0, `${fs.length} receipt(s) in reports/safari`, "no reports/safari/*.json: run `node scripts/safari/run.mjs --seal --tasks 15.12` (#510)"); } },
      manual("safari-checklist", "15.12 checklist passes in Safari macOS and iOS", "רשימת 15.12 עוברת ב-Safari ב-macOS וב-iOS"),
      manual("word-rtl", "The exported .docx reads right-to-left correctly in Word", "קובץ ה-.docx המיוצא נקרא נכון מימין לשמאל ב-Word"),
      manual("share-sheet", "Sharing to Lumen lands in inbox.md", "שיתוף ל-Lumen נוחת ב-inbox.md"),
      manual("phone", "Widget, Siri, voice note < 1 s, Files-app vault, LAN sync", "ווידג׳ט, ‏Siri, הערה קולית < שנייה, כספת בקבצים, סנכרון ברשת המקומית"),
      manual("screen-readers", "VoiceOver, NVDA and TalkBack journeys pass", "המסעות ב-VoiceOver, ‏NVDA ו-TalkBack עוברים"),
    ],
    covers: ["Safari|BrowserStack Live", "\\bWord\\b", "Voice note|share one WhatsApp|Files-app|widget|Siri", "Guidepup|VoiceOver|NVDA|TalkBack", "second screen|Presenter view", "npm run dev|tauri dev|tauri:dev", "Pixel|Argon2id", "Margins|UPDATE_ACADEMIC_GOLDEN"],
  },
  {
    id: "devices/desktop-release",
    session: "devices",
    minutes: 60,
    plan: ["15.8", "W4.5", "W6.43", "W1.24"],
    prs: [492, 479, 423, 413, 395],
    en: "Desktop: the native build, beta.1 and the update drill to beta.2, the store packages",
    he: "שולחן עבודה: הבנייה ה-native, ‏beta.1 ותרגיל העדכון ל-beta.2, חבילות החנויות",
    do: {
      en: ["Linux or Mac (#479): `sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev` (Linux), `cargo check --locked --manifest-path src-tauri/Cargo.toml && npm ci && npm run tauri:build`.", "The release (#492), on the Mac from main: export TAURI_SIGNING_PRIVATE_KEY, its password and LUMEN_RELEASE_KEY; `npm run release -- 0.2.0-beta.1 --dry-run`, read release/DRY-RUN.md, then `--publish`.", "The drill: install beta.1, write release-notes/0.2.0-beta.2.{he,en}.md, `npm run release -- 0.2.0-beta.2 --publish`, then Check for updates in the app → it installs and restarts.", "Store packages (#423): `node scripts/release.mjs packages`, then brew audit / winget validate / flatpak-builder / makepkg on each OS.", "Per release, the signed privacy audit (#395): `brew install mitmproxy`, then `LUMEN_RELEASE_PASSPHRASE=… node scripts/privacy/audit.mjs --sign ~/.lumen-release/lumen-release.key --publish` and commit security/privacy-audits/."],
      he: ["‏Linux או Mac ‏(#479): ‏`sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev` ‏(Linux), ‏`cargo check --locked --manifest-path src-tauri/Cargo.toml && npm ci && npm run tauri:build`.", "השחרור (#492), ב-Mac מ-main: ‏export ל-TAURI_SIGNING_PRIVATE_KEY, לסיסמה שלו ול-LUMEN_RELEASE_KEY; ‏`npm run release -- 0.2.0-beta.1 --dry-run`, לקרוא את release/DRY-RUN.md, ואז `--publish`.", "התרגיל: להתקין את beta.1, לכתוב release-notes/0.2.0-beta.2.{he,en}.md, ‏`npm run release -- 0.2.0-beta.2 --publish`, ואז ״בדיקת עדכונים״ באפליקציה ← היא מתקינה ומופעלת מחדש.", "חבילות החנויות (#423): ‏`node scripts/release.mjs packages`, ואז brew audit / winget validate / flatpak-builder / makepkg בכל מערכת.", "בכל שחרור, ביקורת הפרטיות החתומה (#395): ‏`brew install mitmproxy`, ואז `LUMEN_RELEASE_PASSPHRASE=… node scripts/privacy/audit.mjs --sign ~/.lumen-release/lumen-release.key --publish` וביצוע commit ל-security/privacy-audits/."],
    },
    checks: [
      { id: "beta1", auto: true, en: "Release v0.2.0-beta.1 is published with latest.json", he: "השחרור v0.2.0-beta.1 פורסם עם latest.json", run: async (ctx) => { const r = await ghJson(ctx, `repos/${REPO}/releases/tags/v0.2.0-beta.1`); return r.status === 200 ? ok((r.json?.assets ?? []).some((a) => a.name === "latest.json"), `${(r.json?.assets ?? []).length} assets`, "published without latest.json") : ok(false, "", `v0.2.0-beta.1: HTTP ${r.status}`); } },
      { id: "beta2", auto: true, en: "Release v0.2.0-beta.2 is published (the drill's N+1)", he: "השחרור v0.2.0-beta.2 פורסם (ה-N+1 של התרגיל)", run: async (ctx) => { const r = await ghJson(ctx, `repos/${REPO}/releases/tags/v0.2.0-beta.2`); return ok(r.status === 200, "published", `v0.2.0-beta.2: HTTP ${r.status}`); } },
      { id: "bundle", auto: true, en: "tauri:build produced a bundle", he: "‏tauri:build יצר חבילה", run: async (ctx) => ok(ctx.list(ctx.path("src-tauri/target/release/bundle")).length > 0, "src-tauri/target/release/bundle", "no src-tauri/target/release/bundle") },
      { id: "privacy-audit", auto: true, en: "A signed privacy audit is committed", he: "ביקורת פרטיות חתומה נשמרה", run: async (ctx) => { const fs = ctx.list(ctx.path("security/privacy-audits")); return ok(fs.some((f) => f.endsWith(".minisig")), `${fs.filter((f) => f.endsWith(".json")).length} audit(s)`, "no security/privacy-audits/*.minisig"); } },
      manual("update-drill", "beta.1 found beta.2, installed it and restarted", "‏beta.1 מצא את beta.2, התקין אותו והופעל מחדש"),
      manual("packages", "brew / winget / flatpak / makepkg validations pass", "האימותים של brew / ‏winget / ‏flatpak / ‏makepkg עוברים"),
    ],
    covers: ["tauri:build|tauri build", "libwebkit2gtk", "cargo (check|build|test)", "release -- 0\\.2|release\\.mjs (build|packages|rollback)|release:", "TAURI_SIGNING_PRIVATE_KEY|LUMEN_RELEASE_", "brew audit|winget validate|flatpak-builder|makepkg", "Xcode|xcworkspace", "release-notes/|changelog/he\\.md", "mitmproxy|privacy/audit|privacy-labels", "desktop-native"],
  },
  {
    id: "devices/mobile",
    session: "devices",
    minutes: 45,
    plan: ["13.3", "13.7", "W4.22", "W6.24"],
    prs: [493, 425],
    en: "Mobile: signed Android and iOS builds to internal testing, and a Firebase robo run",
    he: "מובייל: בניות חתומות ל-Android ול-iOS לבדיקה פנימית, וריצת robo ב-Firebase",
    do: {
      en: ["App Store Connect → Apps → + New App (com.lumen.editor); Play Console → create the app.", "On the Mac, with ANDROID_* and ASC_* exported as #493 lists: `npm ci && npm run mobile:check && npm run mobile:android -- --version 0.2.0-beta.1 && npm run mobile:ios -- --version 0.2.0-beta.1`.", "Upload the .aab to Play → Internal testing; TestFlight → Internal Testing after processing.", "This command then offers the Firebase robo run on the debug APK (it asks)."],
      he: ["‏App Store Connect ← Apps ← + New App ‏(com.lumen.editor); ‏Play Console ← ליצור את האפליקציה.", "ב-Mac, עם ANDROID_* ו-ASC_* כמו ש-#493 מפרט: ‏`npm ci && npm run mobile:check && npm run mobile:android -- --version 0.2.0-beta.1 && npm run mobile:ios -- --version 0.2.0-beta.1`.", "להעלות את ה-.aab ל-Play ← Internal testing; ‏TestFlight ← Internal Testing אחרי העיבוד.", "אחר כך הפקודה מציעה את ריצת ה-robo של Firebase על ה-APK לדיבוג (היא שואלת)."],
    },
    actions: [{ en: "Firebase Test Lab robo run on the debug APK", cmd: ["gcloud", "firebase", "test", "android", "run", "--type", "robo", "--app", "release/mobile/lumen-0.2.0-beta.1-debug.apk"], needsFile: "release/mobile/lumen-0.2.0-beta.1-debug.apk", record: "robo" }],
    checks: [
      { id: "aab", auto: true, en: "A signed .aab was built", he: "נבנה ‎.aab חתום", run: async (ctx) => ok(ctx.list(ctx.path("release/mobile")).some((f) => f.endsWith(".aab")), "release/mobile/*.aab", "no release/mobile/*.aab") },
      { id: "robo", auto: true, en: "The Firebase robo run passed", he: "ריצת ה-robo ב-Firebase עברה", run: async (ctx) => (ctx.ran.robo === undefined ? need("the robo action did not run") : ok(ctx.ran.robo === 0, "robo: passed", `robo: exit ${ctx.ran.robo}`)) },
      manual("internal-testing", "Play internal testing and TestFlight builds are live", "הבניות ב-Play internal testing וב-TestFlight זמינות"),
    ],
    covers: ["mobile:(check|android|ios)", "gcloud firebase test android", "ANDROID_HOME|ANDROID_KEYSTORE|ASC_KEY|APPLE_TEAM_ID", "Codemagic", "gradlew", "Play Console|TestFlight"],
  },
  {
    id: "devices/live-and-merge",
    session: "devices",
    minutes: 25,
    plan: ["15.1", "W6.1", "W6.2"],
    prs: [431, 498, 495],
    en: "Merge the trains last, then check the live site and ask for a re-crawl",
    he: "למזג את הרכבות בסוף, ואז לבדוק את האתר החי ולבקש סריקה מחדש",
    do: {
      en: ["After the full e2e and the data drill pass on the train (W6.1): merge #431, then the rest per the plan.", "After the production deploy, this command runs `npm run live:meta -- --self-test` (#498).", `Google Search Console → URL inspection → Request indexing for ${SITE}/ and submit ${SITE}/sitemap.xml; Bing Webmaster Tools → URL submission, same URLs. After 14 days, a site: search of the old domain must not return Lumen.`],
      he: ["אחרי שה-e2e המלא ותרגיל הנתונים עוברים על הרכבת (W6.1): למזג את #431, ואז את השאר לפי התוכנית.", "אחרי הפריסה ל-production, הפקודה מריצה `npm run live:meta -- --self-test` ‏(#498).", `‏Google Search Console ← URL inspection ← Request indexing ל-${SITE}/ ולשלוח את ${SITE}/sitemap.xml; ‏Bing Webmaster Tools ← URL submission, אותן כתובות. אחרי 14 יום, חיפוש site: של הדומיין הישן לא מחזיר את Lumen.`],
    },
    actions: [{ en: "Check the live site's metadata", cmd: ["npm", "run", "live:meta", "--", "--self-test"], needsScript: "live:meta", record: "live-meta" }],
    checks: [
      { id: "train-merged", auto: true, en: "#431 (train 1) is merged", he: "‏#431 (רכבת 1) ממוזג", run: merged(431) },

      { id: "security-md", auto: true, en: "SECURITY.md points to a reporting channel that works", he: "‏SECURITY.md מפנה לערוץ דיווח שעובד", run: async (ctx) => { const r = await ghJson(ctx, `repos/${REPO}/contents/SECURITY.md`); const t = r.json?.content ? Buffer.from(r.json.content, "base64").toString("utf8") : ""; return r.status === 200 ? ok(/Security%20contact%20request/.test(t), "it does", "main\u2019s SECURITY.md still links only GitHub private reporting, which is off (W10.D15 fixes it)") : need(`HTTP ${r.status}`); } },
      { id: "live-meta", auto: true, en: "live:meta passed on production", he: "‏live:meta עבר על production", run: async (ctx) => (ctx.ran["live-meta"] === undefined ? need("the live:meta action did not run (needs #498)") : ok(ctx.ran["live-meta"] === 0, "live:meta: passed", `live:meta: exit ${ctx.ran["live-meta"]}`)) },
      manual("recrawl", "Re-crawl requested in Google and Bing", "סריקה מחדש התבקשה ב-Google וב-Bing"),
    ],
    covers: ["live:meta", "Search Console|Bing Webmaster|re-crawl|site: search", "Merging and the e2e round|merge #431|\\*\\*15\\.1\\*\\*"],
  },
];

export const stepById = (id) => STEPS.find((s) => s.id === id);
export const stepsOf = (session) => STEPS.filter((s) => s.session === session);
