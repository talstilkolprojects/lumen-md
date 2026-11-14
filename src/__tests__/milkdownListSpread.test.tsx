/**
 * Lists in the WYSIWYG editor: Milkdown 7.20 parses `spread` as a string
 * against a boolean-validated attribute, which prosemirror-model ≥ 1.25
 * rejects — every note with a list opened empty. listSpreadFix restores it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import { listSpreadFix } from "../editor/milkdownListSpread";

afterEach(() => {
  document.body.innerHTML = "";
});

async function open(src: string, fix: boolean) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let make = Editor.make().config((ctx) => {
    ctx.set(rootCtx, host);
    ctx.set(defaultValueCtx, src);
  }).use(commonmark).use(gfm);
  if (fix) make = make.use(listSpreadFix);
  const ed = await make.create();
  const doc = ed.action((ctx) => ctx.get(editorViewCtx).state.doc);
  const md = ed.action(getMarkdown());
  await ed.destroy();
  return { doc, md };
}

const SRC = "- תזכורת חשובה\n- second\n\n1. one\n2. two\n\n- [x] done\n- [ ] todo\n";

describe("listSpreadFix", () => {
  it("opens bullet, ordered and task lists and writes them back", async () => {
    const { doc, md } = await open(SRC, true);
    const names: string[] = [];
    doc.descendants((n) => {
      names.push(n.type.name);
      return true;
    });
    expect(names.filter((n) => n.endsWith("_list"))).toEqual(["bullet_list", "ordered_list", "bullet_list"]);
    expect(doc.textContent).toContain("תזכורת חשובה");
    expect(md).toContain("1. one");
    expect(md).toMatch(/\[x\] done/);
  });

  it("is needed: without it the same note opens without its lists", async () => {
    const { doc } = await open(SRC, false).catch(() => ({ doc: null }));
    expect(doc?.textContent ?? "").not.toContain("תזכורת חשובה");
  });
});
