import { test, expect, type Request } from "@playwright/test";

/**
 * Plan 6.17 — cloud only by choice. The local-only journey (2.4) extended
 * to every AI command: with keys for three cloud providers saved and a
 * cloud provider selected — everything that could tempt a fallback — each
 * command runs under the local-only policy, and
 *   - no request reaches a cloud AI host or the public LanguageTool API
 *     (none is even attempted: the privacy ledger lists none, blocked or not);
 *   - the browser's online speech recognition is never started;
 *   - no sentence is handed to a server-side read-aloud voice.
 * Model downloads (Hugging Face) are not user content; they are aborted here
 * only to keep the run small.
 */
const CLOUD_HOSTS = ["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "api.mistral.ai", "api.languagetool.org"];

/** Every command that runs a model, a speech service or a cloud-capable checker. */
const AI_COMMANDS = [
  "view.grammarCheck",
  "tools.checkGrammar",
  "view.smartSearch",
  "tools.autoTag",
  "tools.suggestLinks",
  "ai.productAgent",
  "ai.diagram",
  "ai.actionItems",
  "ai.translate",
  "ai.chart",
  "ai.outline",
  "ai.batch",
  "ai.batchCheck",
  "ai.styleProfile",
  "ai.fineTune",
  "research.ask",
  "research.verify",
  "image.altText",
  "vault.digest",
  "note.read",
  "voice.dictate",
  "voice.memo",
];

test("local-only: every AI command, 0 requests to the cloud", async ({ page }) => {
  test.setTimeout(180_000);
  const cloud: string[] = [];
  const watch = (r: Request) => {
    let host = "";
    try {
      host = new URL(r.url()).hostname;
    } catch {
      return;
    }
    if (CLOUD_HOSTS.includes(host)) cloud.push(`${r.method()} ${r.url()}`);
  };
  page.on("request", watch);
  for (const host of CLOUD_HOSTS) await page.route(`https://${host}/**`, (route) => route.abort());
  await page.route(/huggingface\.co|hf\.co/, (route) => route.abort());

  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.setItem("lumen.ai.policy", "local-only");
    localStorage.setItem("lumen.ai.provider", "anthropic");
    for (const p of ["anthropic", "gemini", "mistral"]) localStorage.setItem(`lumen.ai.key.${p}`, "test-key");
    const w = window as unknown as { __speech: { recognitions: number; spoken: string[] } };
    w.__speech = { recognitions: 0, spoken: [] };
    // The browser's online services, made observable.
    class FakeRecognition {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult = null;
      onerror = null;
      onend = null;
      constructor() {
        w.__speech.recognitions++;
      }
      start() {}
      stop() {}
    }
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: FakeRecognition });
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: FakeRecognition });
    const voices = [{ name: "Google עברית", lang: "he-IL", localService: false, default: true, voiceURI: "net-he" }, { name: "Google US English", lang: "en-US", localService: false, default: false, voiceURI: "net-en" }];
    class FakeUtterance {
      lang = "";
      rate = 1;
      voice: { name: string } | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: FakeUtterance });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => voices,
        cancel: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        speak: (u: FakeUtterance) => {
          w.__speech.spoken.push(u.voice?.name ?? "default voice");
          u.onend?.();
        },
      },
    });
  });
  await page.goto("/");
  const editor = page.locator(".cm-content").first();
  await expect(editor).toContainText("Welcome to", { timeout: 15_000 });
  await editor.click();
  await editor.fill("# סקירה\n\nThis are a sentence with enough words in it to be worth a grammar check today.\n\nשורה בעברית עם מספיק מילים כדי שבודק הדקדוק ירצה לבדוק אותה.\n\n- [ ] משימה\n");

  const modal = page.locator('[role="dialog"][aria-modal="true"], [role="alertdialog"]');
  /** Close whatever the command opened (prompts, panels) until nothing modal is left. */
  const settle = async () => {
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(async () => {
      if ((await modal.count()) > 0) await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0, { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
  };

  for (const id of AI_COMMANDS) {
    await page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);
    await settle();
    expect(cloud, `after ${id}`).toEqual([]);
  }

  // Background checks run on the next edit, with the grammar check on.
  await editor.click();
  await page.keyboard.type(" They was here yesterday and they has gone now.");
  await page.waitForLoadState("networkidle").catch(() => {});

  const speech = await page.evaluate(() => (window as unknown as { __speech: { recognitions: number; spoken: string[] } }).__speech);
  expect(speech.recognitions, "online speech recognition started").toBe(0);
  expect(speech.spoken.filter((v) => v !== "default voice"), "sentences sent to a server-side voice").toEqual([]);
  expect(speech.spoken, "sentences left to the default voice").toEqual([]);

  // The ledger lists no cloud host — not even a blocked attempt.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "ai.privacyLedger" } })));
  const ledger = page.locator('[role="dialog"][aria-label="Privacy ledger"]');
  await expect(ledger).toBeVisible({ timeout: 5000 });
  for (const host of CLOUD_HOSTS) await expect(ledger).not.toContainText(host);
  await page.keyboard.press("Escape");

  expect(cloud, "requests to the cloud").toEqual([]);
});
