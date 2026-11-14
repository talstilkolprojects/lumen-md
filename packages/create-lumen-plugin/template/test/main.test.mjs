// Tests run in Node with Lumen's plugin test kit: the same API and the
// same capability rules as the app's sandbox. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "../tools/testkit.mjs";

const dir = new URL("..", import.meta.url).pathname;

test("registers its command", async () => {
  const p = await loadPlugin({ dir });
  assert.ok(p.commands.has("show"));
});

test("shows the count of the open note in the panel", async () => {
  const p = await loadPlugin({ dir, document: { text: "שלום עולם and hello", fileName: "Note.md" } });
  await p.run("show");
  assert.equal(p.panel.open, true);
  assert.deepEqual(p.panel.tree.children[1], { type: "text", text: "4 words · 19 characters" });
});

test("without the document:read grant, the call is refused", async () => {
  const p = await loadPlugin({ dir, grants: ["commands", "panel"] });
  await assert.rejects(p.run("show"), { name: "PluginDenied" });
  assert.equal(p.denied.get("document:read"), 1);
});
