/**
 * Right-click on an image embed in the source editor: "Copy image" (plan
 * W7.3). The vault file goes to the clipboard as PNG (the one image type
 * every browser's clipboard takes); nothing leaves the device.
 */
import { t } from "../i18n";
import "./imageCopyStrings";
import { candidatesFor } from "../storage/attachmentRefs";
import { workspaceTree } from "../storage/workspaceIndex";
import { readWorkspaceBlob, type WorkspaceNode } from "../storage/workspace";
import { toast } from "../store/useToastStore";
import { explainError } from "../lib/userError";

function filesOf(nodes: readonly WorkspaceNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "file") out.push(n.path);
    else if (n.children) filesOf(n.children, out);
  }
  return out;
}

/** The vault path an embed in `notePath` shows, or null. */
export async function resolveImage(target: string, notePath: string): Promise<string | null> {
  const files = filesOf(await workspaceTree());
  const byName = new Map<string, string[]>();
  for (const f of files) {
    const k = (f.split("/").pop() ?? f).toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), f]);
  }
  const clean = target.replace(/[?#].*$/, "");
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // why: a literal % in the name; the name as written is tried
  }
  return candidatesFor({ target: decoded, kind: "markdown" }, notePath, new Set(files), byName, true)[0] ?? null;
}

async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("toBlob"))), "image/png"));
}

export async function copyImage(target: string, notePath: string): Promise<void> {
  const path = await resolveImage(target, notePath);
  if (!path) {
    toast.error(t("imageCopy.notFound", { name: target }));
    return;
  }
  try {
    const blob = await readWorkspaceBlob(path);
    const typed = blob.type ? blob : new Blob([blob], { type: /\.svg$/i.test(path) ? "image/svg+xml" : "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": asPng(typed) })]);
    toast.success(t("imageCopy.copied"));
  } catch (e) {
    toast.error(t("imageCopy.failed", { error: explainError(e) }));
  }
}

let open: HTMLElement | null = null;

/** A one-item menu at the pointer; Escape, a click elsewhere or a scroll closes it. */
export function openImageMenu(target: string, notePath: string, at: { x: number; y: number }): void {
  open?.remove();
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.dataset.testid = "image-menu";
  menu.setAttribute("aria-label", t("imageCopy.menu"));
  const left = Math.max(8, Math.min(at.x, window.innerWidth - 208));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 50));
  menu.style.cssText = `position:fixed;left:${Math.round(left)}px;top:${Math.round(top)}px;min-width:200px;background:hsl(var(--bg));border:1px solid hsl(var(--border-strong));border-radius:10px;box-shadow:var(--shadow-lg);z-index:10001;padding:6px 0`;
  const item = document.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.style.cssText = "display:flex;width:100%;padding:6px 14px;border:none;background:transparent;color:hsl(var(--fg));font-size:13px;cursor:pointer;text-align:start";
  item.textContent = t("imageCopy.copy");
  menu.append(item);
  const close = () => {
    menu.remove();
    if (open === menu) open = null;
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("scroll", close, true);
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  item.addEventListener("click", () => {
    close();
    void copyImage(target, notePath);
  });
  document.body.append(menu);
  open = menu;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", key, true);
  window.addEventListener("scroll", close, true);
  item.focus();
}
