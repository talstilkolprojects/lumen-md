/**
 * Plan W4.21 — drive the journey (./journey.ts) with a Guidepup screen
 * reader and record what it spoke, task by task.
 */
import type { Page, TestInfo } from "@playwright/test";
import { JOURNEY_NOTE, TASKS, missing, resultRow } from "./journey";

/** What the spec needs from Guidepup's VoiceOver or NVDA fixture. */
export interface Reader {
  navigateToWebContent(): Promise<void>;
  next(): Promise<void>;
  clearSpokenPhraseLog(): Promise<void>;
  spokenPhraseLog(): Promise<string[]>;
}

export const BASE_URL = process.env.LUMEN_SR_URL ?? "http://localhost:4317/";

export async function openJourney(page: Page): Promise<void> {
  await page.addInitScript((content) => {
    localStorage.clear();
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: "he", mode: "source", doc: { name: "תוכנית.md", content, dirty: false, workspaceName: null } }, version: 0 }));
  }, JOURNEY_NOTE);
  await page.goto(BASE_URL, { waitUntil: "load" });
  await page.locator("html[dir=rtl]").waitFor();
}

/** Run every task; return the per-task result and attach it (and the protocol row) to the test report. */
export async function runJourney(page: Page, reader: Reader, setup: string, info: TestInfo) {
  await openJourney(page);
  await reader.navigateToWebContent();
  const results: Array<{ id: number; title: string; spoken: string[]; missing: string[] }> = [];
  for (const task of TASKS) {
    if (task.id !== 1) await reader.clearSpokenPhraseLog();
    for (const key of task.keys ?? []) await page.keyboard.press(key);
    if (task.type) await page.keyboard.type(task.type);
    for (let i = 0; i < (task.readerNext ?? 0); i++) await reader.next();
    // Give the reader time to finish speaking: poll until the log stops growing.
    let last = -1;
    let spoken: string[] = [];
    for (let i = 0; i < 20; i++) {
      spoken = await reader.spokenPhraseLog();
      if (spoken.length === last) break;
      last = spoken.length;
      await new Promise((r) => setTimeout(r, 250));
    }
    results.push({ id: task.id, title: task.title, spoken, missing: missing(task, spoken) });
  }
  const row = resultRow(new Date().toISOString().slice(0, 10), process.env.npm_package_version ?? "dev", setup, results);
  await info.attach(`${setup}.json`, { body: JSON.stringify({ setup, row, results }, null, 2), contentType: "application/json" });
  console.log(row);
  return results;
}
