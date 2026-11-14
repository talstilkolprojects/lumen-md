/**
 * Plan 4.9 — the properties panel edits the note through the properties
 * API: one field changed, the rest of the text untouched.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { PropertiesPanel } from "../ui/PropertiesPanel";

const NOTE = "---\n# keep me\ntitle: 'Draft'\ndone: false\ntags:\n  - a\n---\nBody\n";

let latest = "";
function Harness({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  latest = text;
  return (
    <PropertiesPanel
      open
      onClose={() => {}}
      text={text}
      applyEdit={(edit) => setText((cur) => edit(cur))}
    />
  );
}

afterEach(cleanup);

describe("<PropertiesPanel>", () => {
  it("lists the properties with typed fields", () => {
    render(<Harness initial={NOTE} />);
    expect((screen.getByLabelText("Value of title") as HTMLInputElement).value).toBe("Draft");
    expect((screen.getByLabelText("Value of done") as HTMLInputElement).type).toBe("checkbox");
    expect((screen.getByLabelText("Type of tags") as HTMLSelectElement).value).toBe("list");
  });

  it("commits a text edit on Enter, changing only that value", () => {
    render(<Harness initial={NOTE} />);
    const input = screen.getByLabelText("Value of title");
    fireEvent.change(input, { target: { value: "Final" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(latest).toBe(NOTE.replace("title: 'Draft'", "title: 'Final'"));
  });

  it("toggles a checkbox, adds a list item, removes and adds properties", () => {
    render(<Harness initial={NOTE} />);
    fireEvent.click(screen.getByLabelText("Value of done"));
    expect(latest).toBe(NOTE.replace("done: false", "done: true"));
    const item = screen.getByLabelText("Add an item to tags");
    fireEvent.change(item, { target: { value: "b" } });
    fireEvent.keyDown(item, { key: "Enter" });
    expect(latest).toContain("tags:\n  - a\n  - b\n---");
    fireEvent.click(screen.getByLabelText("Remove done"));
    expect(latest).not.toContain("done:");
    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "status" } });
    fireEvent.click(screen.getByLabelText("Add property"));
    expect(latest).toContain("\nstatus:\n---\nBody\n");
    expect(latest).toContain("# keep me");
  });

  it("edits timestamps with seconds or a time zone as text, keeping them whole", () => {
    const note = "---\nwhen: 2026-10-18T12:34:56+02:00\nat: 2026-10-18 09:30\n---\n";
    render(<Harness initial={note} />);
    const when = screen.getByLabelText("Value of when") as HTMLInputElement;
    expect(when.type).toBe("text");
    expect(when.value).toBe("2026-10-18T12:34:56+02:00");
    const at = screen.getByLabelText("Value of at") as HTMLInputElement;
    expect(at.type).toBe("datetime-local");
    fireEvent.change(at, { target: { value: "2026-10-19T10:00" } });
    expect(latest).toBe(note.replace("at: 2026-10-18 09:30", "at: 2026-10-19 10:00"));
  });

  it("opens a link property at its heading", async () => {
    vi.doMock("../storage/workspace", async (orig) => ({ ...(await orig<object>()), listWorkspace: async () => [{ path: "docs/Guide.md", name: "Guide.md", size: 0, modified: 0 }] }));
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("lumen-open-file", on);
    render(<Harness initial={"---\nsee: \"[[Guide#Getting Started]]\"\n---\n"} />);
    fireEvent.click(screen.getByLabelText("Open Guide#Getting Started"));
    await vi.waitFor(() => expect(seen).toEqual([{ path: "docs/Guide.md", heading: "getting-started" }]));
    window.removeEventListener("lumen-open-file", on);
    vi.doUnmock("../storage/workspace");
  });

  it("shows why an invalid frontmatter can't be edited, and offers to add to a note without one", () => {
    render(<Harness initial={"---\na: [1, 2\n---\n"} />);
    expect(screen.getByRole("alert").textContent).toMatch(/valid YAML/);
    cleanup();
    render(<Harness initial={"Just text"} />);
    expect(screen.getByText("This note has no properties yet.")).toBeTruthy();
  });
});
