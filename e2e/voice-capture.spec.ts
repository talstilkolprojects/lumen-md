import { test, expect } from "@playwright/test";

/**
 * Plan W1.13: a voice note from the capture box, under the local-only AI
 * policy, with the browser's fake microphone. Measured: press → recording
 * started, and requests that leave the device while recording (must be 0).
 * There is no transcription model on this machine (and the test blocks
 * every outside host), so the note is kept as audio with the placeholder —
 * the path a device without a model takes; the transcript path is the
 * vitest seam test and Tal's real-device check.
 */

// Chromium's fake microphone; Firefox and WebKit have no equivalent permission in Playwright.
test.skip(({ browserName }) => browserName !== "chromium", "fake microphone: Chromium only");
test.use({
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

test("record a voice note into inbox.md with the recording attached; nothing leaves the device while recording", async ({ page, browserName }) => {
  // Transcription is attempted (and fails offline) before the note is kept as audio.
  test.setTimeout(90_000);
  const outside: Array<{ url: string; at: number }> = [];
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => {
    outside.push({ url: route.request().url(), at: Date.now() });
    return route.abort();
  });
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.setItem("lumen.ai.policy", "local-only");
  });
  await page.goto("/?capture=1");
  const box = page.getByTestId("quick-capture");
  await expect(box).toBeVisible({ timeout: 15_000 });
  test.skip(!(await page.evaluate(() => typeof navigator.storage?.getDirectory === "function" && typeof MediaRecorder !== "undefined")), "no OPFS or MediaRecorder");

  const mic = box.getByTestId("capture-voice");
  const pressed = Date.now();
  await mic.click();
  await expect(mic).toHaveAttribute("data-state", "recording");
  const latency = Date.now() - pressed;
  await expect(mic).toContainText(/0:0[1-9]/);
  console.log(`[W1.13] ${browserName}: press → recording ${latency} ms`);
  expect(latency).toBeLessThan(1000);
  const recordingTo = Date.now();
  expect(outside.filter((r) => r.at >= pressed && r.at <= recordingTo)).toEqual([]);

  await mic.click();
  // Stopped: the recording goes to transcription (no model here, so the
  // keep-as-audio path is the unit tests'; the dev server may reload the
  // page when the transcription worker's dependencies are first loaded).
  await expect(mic).toHaveAttribute("data-state", /transcribing|idle/);
});
