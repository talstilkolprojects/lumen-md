/**
 * What deleting a note does with the attachments only it links to (plan
 * W7.3): ask (the default), always move them to the trash too, or never.
 * Kept per device.
 */

export type AttachmentPolicy = "ask" | "always" | "never";

const KEY = "lumen.attachmentCleanup";

export function attachmentPolicy(): AttachmentPolicy {
  try {
    const v = localStorage.getItem(KEY);
    return v === "always" || v === "never" ? v : "ask";
  } catch {
    return "ask";
  }
}

export function setAttachmentPolicy(next: AttachmentPolicy): void {
  try {
    if (next === "ask") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* private mode: asks again next time */
  }
}
