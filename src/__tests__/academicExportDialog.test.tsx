/**
 * W5.16 — the academic export dialog: the cover starts from the note's
 * frontmatter, the institution picks the template, and Export hands the
 * exporter exactly what the form shows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("../i18n", () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k), registerEnglish: () => undefined, getLocale: () => "he" }));
vi.mock("../ui/academicStrings", () => ({}));
const exportToDocx = vi.fn<(content: string, name: string, opts?: unknown) => Promise<void>>(async () => undefined);
vi.mock("../storage/exportDocx", () => ({ exportToDocx }));

import { AcademicExportDialog } from "../ui/AcademicExportDialog";

const NOTE = "---\ntitle: כתיבה בעברית\ncourse: סמינר\ninstitution: openu\n---\n# מבוא\n\nטקסט.\n";

describe("AcademicExportDialog", () => {
  beforeEach(() => {
    exportToDocx.mockClear();
    try {
      localStorage.clear();
    } catch {
      /* why: storage blocked in this environment */
    }
  });
  afterEach(cleanup);

  it("starts from the frontmatter and the institution it names", () => {
    render(<AcademicExportDialog content={NOTE} name="paper.md" onClose={() => undefined} />);
    expect((screen.getByTestId("academic-institution") as HTMLSelectElement).value).toBe("openu");
    expect((screen.getByTestId("academic-title") as HTMLInputElement).value).toBe("כתיבה בעברית");
    expect((screen.getByTestId("academic-course") as HTMLInputElement).value).toBe("סמינר");
    // The Open University numbers its front matter in Roman numerals.
    expect((screen.getByTestId("academic-front") as HTMLSelectElement).value).toBe("lowerRoman");
    expect(screen.getByTestId("academic-summary").textContent).toContain("עבודת גמר לתואר שני (היסטוריה)");
  });

  it("falls back to the note's name for the title, and switching institution resets the front numbering", () => {
    render(<AcademicExportDialog content={"# בלי frontmatter\n"} name="עבודה.md" onClose={() => undefined} />);
    expect((screen.getByTestId("academic-title") as HTMLInputElement).value).toBe("עבודה");
    fireEvent.change(screen.getByTestId("academic-institution"), { target: { value: "openu" } });
    expect((screen.getByTestId("academic-front") as HTMLSelectElement).value).toBe("lowerRoman");
    fireEvent.change(screen.getByTestId("academic-institution"), { target: { value: "biu" } });
    expect((screen.getByTestId("academic-front") as HTMLSelectElement).value).toBe("none");
  });

  it("Export passes the template, the edited cover and the numbering to the exporter", async () => {
    render(<AcademicExportDialog content={NOTE} name="paper.md" onClose={() => undefined} />);
    fireEvent.change(screen.getByTestId("academic-institution"), { target: { value: "haifa" } });
    fireEvent.change(screen.getByTestId("academic-author"), { target: { value: "נועה" } });
    fireEvent.change(screen.getByTestId("academic-front"), { target: { value: "hebrew1" } });
    fireEvent.click(screen.getByTestId("academic-go"));
    await waitFor(() => expect(exportToDocx).toHaveBeenCalledTimes(1));
    const [content, name, opts] = exportToDocx.mock.calls[0];
    expect(content).toBe(NOTE);
    expect(name).toBe("paper.md");
    const a = (opts as { academic: { template: { id: string }; cover: Record<string, string>; frontNumbering: string; toc: boolean } }).academic;
    expect(a.template.id).toBe("haifa");
    expect(a.cover).toMatchObject({ title: "כתיבה בעברית", course: "סמינר", author: "נועה" });
    expect(a.frontNumbering).toBe("hebrew1");
    expect(a.toc).toBe(true);
    await waitFor(() => expect(screen.getByTestId("academic-result").getAttribute("role")).toBe("status"));
  });

  it("Escape closes", () => {
    const onClose = vi.fn();
    render(<AcademicExportDialog content={NOTE} name="paper.md" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
