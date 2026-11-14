/**
 * Plan W5.10 — the read-only viewer of an encrypted share link
 * (src/share/SharedNoteView.tsx): it decrypts the note from the #fragment,
 * renders it read-only, asks for the key when the link came without it, and
 * refuses a wrong key, a damaged link and an expired note. It writes
 * nothing to this browser's storage.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import SharedNoteView from "../share/SharedNoteView";
import { createShareLink, sealNote, toBase64Url } from "../share/linkShare";

const ORIGIN = "https://lumen-md.vercel.app";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

function openAt(url: string) {
  history.replaceState(null, "", new URL(url).hash || "/");
  return render(<SharedNoteView />);
}

const state = (c: HTMLElement) => c.querySelector("[data-testid=shared-note-error]")?.getAttribute("data-code") ?? null;

describe("SharedNoteView", () => {
  it("decrypts and renders the note read-only, and stores nothing", async () => {
    const before = localStorage.length;
    const link = await createShareLink({ title: "פגישה.md", markdown: "# כותרת הפתק\n\nשלום **עולם**", created: Date.UTC(2026, 0, 1) }, ORIGIN);
    const { container } = openAt(link.url!);
    await waitFor(() => expect(container.querySelector(".prose-lumen h1")?.textContent).toBe("כותרת הפתק"));
    expect(container.querySelector(".prose-lumen strong")?.textContent).toBe("עולם");
    expect(screen.getByTestId("shared-note-meta").textContent).toContain("פגישה.md");
    expect(screen.getByTestId("shared-note-badge").textContent).toContain("read-only");
    // Read-only: no editor, no text field.
    expect(container.querySelector(".cm-content, textarea, [contenteditable=true]")).toBeNull();
    expect(localStorage.length).toBe(before);
  });

  it("a link without its key asks for the key, then opens", async () => {
    const link = await createShareLink({ title: "t", markdown: "# separate key", created: 1 }, ORIGIN);
    const { container } = openAt(link.urlWithoutKey!);
    const input = screen.getByTestId("shared-note-key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: link.key } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(container.querySelector(".prose-lumen h1")?.textContent).toBe("separate key"));
  });

  it("refuses a wrong key, a damaged link and an expired note", async () => {
    const link = await createShareLink({ title: "t", markdown: "x", created: 1 }, ORIGIN);
    const other = await createShareLink({ title: "t", markdown: "x", created: 1 }, ORIGIN);
    const wrong = `${link.urlWithoutKey}&key=${other.key}`;
    let r = openAt(wrong);
    await waitFor(() => expect(state(r.container)).toBe("key"));
    cleanup();

    r = openAt(`${link.urlWithoutKey!.slice(0, -10)}&key=${link.key}`);
    await waitFor(() => expect(state(r.container)).not.toBeNull());
    expect(["key", "malformed"]).toContain(state(r.container));
    cleanup();

    const expired = await sealNote({ title: "t", markdown: "old", created: 1, expires: 2 });
    r = openAt(`${ORIGIN}/#view=${toBase64Url(expired.data)}&key=${toBase64Url(expired.key)}`);
    await waitFor(() => expect(state(r.container)).toBe("expired"));
    expect(r.container.textContent).not.toContain("old");
  });

  it("a file link asks for the encrypted file", () => {
    const { container } = openAt(`${ORIGIN}/#view-file&key=abc`);
    expect(container.querySelector("input[type=file]")).not.toBeNull();
  });
});
