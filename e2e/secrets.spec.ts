import { test, expect } from "@playwright/test";

/**
 * T36 — storage scan: after the app starts, no API key or token is left in
 * plain text in localStorage or IndexedDB.
 */
test("plaintext keys are moved into the encrypted store at startup", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.ai.key.anthropic", "sk-ant-PLAINTEXT-123");
    localStorage.setItem("lumen.cloud.github.token", "ghp_PLAINTEXT_456");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });

  const scan = await page.evaluate(async () => {
    const ls = JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
    const dump: string[] = [];
    const dbs = (await indexedDB.databases?.()) ?? [{ name: "lumen-secrets" }];
    for (const { name } of dbs) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const all = await new Promise<unknown[]>((res) => {
          const req = db.transaction(store).objectStore(store).getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = () => res([]);
        });
        for (const v of all) {
          try {
            dump.push(JSON.stringify(v));
          } catch {
            /* CryptoKey and friends */
          }
          if (v && typeof v === "object" && "data" in v && (v as { data: unknown }).data instanceof ArrayBuffer) {
            dump.push(new TextDecoder().decode((v as { data: ArrayBuffer }).data));
          }
        }
      }
      db.close();
    }
    return { ls, idb: dump.join("\n"), dbs: dbs.map((d) => d.name) };
  });
  expect(scan.ls).not.toContain("PLAINTEXT");
  expect(scan.idb).not.toContain("PLAINTEXT");
  expect(scan.dbs).toContain("lumen-secrets");
});
