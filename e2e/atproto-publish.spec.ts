import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { vaultOrSkip } from "./_opfs";
import { inflateRawSync } from "node:zlib";

/**
 * Publishing to the AT Protocol as Standard.site (plan W7.19), against a
 * PDS mocked with page.route (no real account): a Hebrew note is published,
 * its record is RTL Hebrew with a summary, its frontmatter remembers the
 * record, the site's zip proves ownership (/.well-known and a <link>), the
 * App Password stays out of the vault, localStorage and the console, and
 * publishing again replaces the same record.
 */

/** The site zip's files (the same reader as publish-site.spec.ts). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const NOTE = "---\ntitle: מאמר ראשון\n---\n# מאמר ראשון\n\nזו פסקת הפתיחה של המאמר, בעברית.\n\nהמשך.\n";
const PASSWORD = "abcd-efgh-ijkl-mnop";

async function seed(page: Page): Promise<boolean> {
  return page.evaluate(async (note) => {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = (await root.getFileHandle("מאמר.md", { create: true })) as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
      if (typeof fh.createWritable !== "function") return false;
      const w = await fh.createWritable();
      await w.write(note);
      await w.close();
      return true;
    } catch {
      return false;
    }
  }, NOTE);
}

test("a Hebrew note on a mocked PDS: record, frontmatter, ownership proofs, password kept out", async ({ page, browserName }) => {
  test.setTimeout(90_000);
  const records = new Map<string, Record<string, unknown>>();
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.route("https://bsky.social/xrpc/com.atproto.identity.resolveHandle**", (r) => r.fulfill({ json: { did: "did:plc:tal" } }));
  await page.route("https://tal.bsky.social/**", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("https://plc.directory/**", (r) => r.fulfill({ json: { id: "did:plc:tal", service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.bsky.network" }] } }));
  await page.route("https://pds.bsky.network/xrpc/**", async (r) => {
    const url = r.request().url();
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (url.endsWith("createSession")) return body.password === PASSWORD ? r.fulfill({ json: { did: "did:plc:tal", handle: "tal.bsky.social", accessJwt: "A", refreshJwt: "R" } }) : r.fulfill({ status: 401, json: { error: "AuthenticationRequired", message: "Invalid identifier or password" } });
    if (url.endsWith("refreshSession")) return r.fulfill({ json: { did: "did:plc:tal", handle: "tal.bsky.social", accessJwt: "A2", refreshJwt: "R2" } });
    if (url.endsWith("putRecord")) {
      const uri = `at://${body.repo}/${body.collection}/${body.rkey}`;
      records.set(uri, body.record as Record<string, unknown>);
      return r.fulfill({ json: { uri, cid: "bafy" } });
    }
    return r.fulfill({ status: 404, body: "" });
  });
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  vaultOrSkip(await seed(page), browserName);

  const open = async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "file.publishSite" } })));
    const dialog = page.getByTestId("publish-site");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    return dialog;
  };
  let dialog = await open();
  await dialog.getByTestId("publish-target-zip").check();
  await dialog.getByTestId("publish-atproto").check();
  await dialog.getByTestId("publish-atproto-handle").fill("tal.bsky.social");
  await dialog.getByTestId("publish-atproto-password").fill(PASSWORD);
  await dialog.getByTestId("publish-atproto-site").fill("https://tal.example.com/notes");
  let download = page.waitForEvent("download");
  await dialog.getByTestId("publish-go").click();
  const files = unzip(readFileSync(await (await download).path()));
  await expect(dialog.getByTestId("publish-result")).toBeVisible();

  const docs = [...records.entries()].filter(([k]) => k.includes("site.standard.document"));
  expect(docs).toHaveLength(1);
  const [docUri, rec] = docs[0];
  expect(rec).toMatchObject({ title: "מאמר ראשון", langs: ["he"], textDirection: "rtl" });
  expect(String(rec.description)).toContain("זו פסקת הפתיחה");
  const pubUri = [...records.keys()].find((k) => k.includes("site.standard.publication"))!;
  expect(new TextDecoder().decode(files.get(".well-known/site.standard.publication"))).toBe(`${pubUri}\n`);
  expect(new TextDecoder().decode(files.get("מאמר.html"))).toContain(`<link rel="site.standard.document" href="${docUri}" />`);
  // The note remembers its record; the password is nowhere but the secret store.
  const state = await page.evaluate(async () => {
    const f = await (await (await navigator.storage.getDirectory()).getFileHandle("מאמר.md")).getFile();
    return { note: await f.text(), ls: JSON.stringify({ ...localStorage }) };
  });
  expect(state.note).toContain(`atproto-document: ${docUri}`);
  expect(state.note).not.toContain(PASSWORD);
  expect(state.ls).not.toContain(PASSWORD);
  expect(logs.join("\n")).not.toContain(PASSWORD);

  // Again, without typing the password: the same record is replaced.
  await page.keyboard.press("Escape");
  dialog = await open();
  download = page.waitForEvent("download");
  await dialog.getByTestId("publish-go").click();
  await download;
  expect([...records.keys()].filter((k) => k.includes("site.standard.document"))).toEqual([docUri]);
});
