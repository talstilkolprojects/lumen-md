/**
 * Blind tests (plan W6.15, lane B): true redaction and the export door (#473).
 *
 * Written from the spec only: PR #473's body (with its review 12.11 fixes),
 * docs/src/content/docs/security/journalist-mode.md and the public API of
 * src/lib/redaction.ts and src/storage/exportReady.ts (declarations emitted by tsc, no
 * function bodies). The test list (R1–R11) was written before any implementation was
 * read; the implementation was then opened only to check the import paths.
 *
 * #473 is not on verify/train-2 yet, so the modules are looked up with
 * import.meta.glob and the suite skips while they are absent (the same seam as
 * src/share/shareReady.ts). It was run on the feat/journalist-mode head (d84230e0c);
 * it runs here by itself once #473 is merged. Failing cases are `it.fails` entries that
 * link to a finding in the W6.15 findings list (PR body of test/blind-tests).
 */
import { describe, expect, it } from "vitest";

interface Redaction {
  REDACTED: string;
  WITHHELD_IMAGE: string;
  wrapRedaction(text: string): string;
  hasRedactions(markdown: string): boolean;
  redactedPassages(markdown: string): string[];
  removeRedacted(markdown: string): { text: string; count: number };
  removeHiddenComments(markdown: string): string;
  cleanInlineImages(markdown: string): { text: string; cleaned: number; withheld: number };
  prepareForExportSync(markdown: string, opts?: { keepImageMetadata?: boolean }): string;
  prepareForExport(markdown: string, opts?: { keepImageMetadata?: boolean }): Promise<{ text: string; report: { redacted: number; imagesCleaned: number; imagesWithheld: number } }>;
}
interface Door {
  exportReadyText(markdown: string, inlinePhotos?: boolean): Promise<string>;
}

// A pattern with "*" (it matches only these two files) rather than a literal path, so
// the offline shim's glob expands it too.
const pick = <T>(mods: Record<string, unknown>, file: string) => Object.entries(mods).find(([k]) => k.endsWith(file))?.[1] as T | undefined;
const red = pick<Redaction>(import.meta.glob("../../lib/redact*.ts", { eager: true }), "/redaction.ts");
const door = pick<Door>(import.meta.glob("../../storage/exportRead*.ts", { eager: true }), "/exportReady.ts");
const S = "SECRET-מקור-0501234567";

// skip-reason: a blind test (W6.15) written from #473's spec before its code; it runs wherever redaction.ts and exportReady.ts exist (every train has them) | task: W6.15 | until: 2027-05-12
describe.skipIf(!red || !door)("redaction (#473)", () => {
  const r = red!;
  const exp = (md: string) => r.prepareForExportSync(md, { keepImageMetadata: false });

  describe("marked passages (R1–R4, R11)", () => {
    it("a passage becomes exactly one placeholder and is counted", () => {
      const out = r.removeRedacted(`before <redact>${S}</redact> after`);
      expect(out.text).toBe(`before ${r.REDACTED} after`);
      expect(out.count).toBe(1);
      expect(r.REDACTED).toBe("█".repeat(5));
    });

    it("the placeholder doesn't depend on the secret's length", () => {
      const a = r.removeRedacted("x <redact>a</redact> y").text;
      const b = r.removeRedacted(`x <redact>${"long name ".repeat(50)}</redact> y`).text;
      expect(a).toBe(b);
    });

    it("nested marks: the outermost pair wins", () => {
      const out = r.removeRedacted(`A <redact>one <redact>${S}</redact> two</redact> B`);
      expect(out.text).toBe(`A ${r.REDACTED} B`);
      for (const w of ["one", "two", S]) expect(out.text).not.toContain(w);
    });

    it("an unclosed mark removes everything after it", () => {
      const out = r.removeRedacted(`public <redact>${S}\n\nmore secret\n# heading`).text;
      expect(out.startsWith("public ")).toBe(true);
      for (const w of [S, "more secret", "heading"]) expect(out).not.toContain(w);
    });

    it("marks count inside fenced code and code spans", () => {
      for (const md of ["```\nx <redact>" + S + "</redact>\n```", "`<redact>" + S + "</redact>`", "~~~js\n<redact>" + S + "</redact>\n~~~", "    indented <redact>" + S + "</redact>"]) {
        expect(r.removeRedacted(md).text).not.toContain(S);
        expect(exp(md)).not.toContain(S);
      }
    });

    it("hasRedactions and redactedPassages see the marks as written", () => {
      const md = `a <redact>one</redact> b <redact>${S}</redact>`;
      expect(r.hasRedactions(md)).toBe(true);
      expect(r.hasRedactions("plain")).toBe(false);
      expect(r.redactedPassages(md)).toEqual(["one", S]);
    });
  });

  describe("hidden comments (R5, R6)", () => {
    it("HTML and Obsidian comments go; a lone %% stays", () => {
      const out = r.removeHiddenComments(`a <!-- ${S} --> b %%${S}%% c 50%% off`);
      expect(out).not.toContain(S);
      expect(out).toContain("a ");
      expect(out).toContain("50%% off");
    });

    it("an unclosed HTML comment runs to the end", () => {
      const out = r.removeHiddenComments(`public\n<!-- ${S}\nmore`);
      expect(out).toContain("public");
      expect(out).not.toContain(S);
      expect(out).not.toContain("more");
    });

    it("multi-line Obsidian comments go", () => {
      expect(r.removeHiddenComments(`a\n%%\n${S}\nline\n%%\nb`)).not.toContain(S);
    });

    it("comments inside code are code, and stay", () => {
      const md = "```html\n<!-- keep me -->\n```\n`%%also%%`";
      const out = r.removeHiddenComments(md);
      expect(out).toContain("<!-- keep me -->");
      expect(out).toContain("%%also%%");
    });

    it("a lone backtick is not a code span: the comment after it still goes (adversarial)", () => {
      // (A line that starts with four backticks and has none after them opens a fence in
      // CommonMark, so a comment there is code: not a case for this test.)
      for (const md of [`price \` and <!-- ${S} --> rest`, `a \`\`b <!-- ${S} --> c`]) {
        expect(exp(md)).not.toContain(S);
      }
    });
  });

  describe("adversarial marks (R7, R8)", () => {
    it("HTML is case-insensitive: <REDACT> and <Redact> fail closed", () => {
      for (const md of [`a <REDACT>${S}</REDACT> b`, `a <Redact>${S}</Redact> b`]) expect(exp(md)).not.toContain(S);
    });

    it("a mark with spaces or a line break before '>' fails closed", () => {
      for (const md of [`a <redact >${S}</redact> b`, `a <redact\n>${S}</redact> b`, `a <redact>${S}</ redact> b`]) expect(exp(md)).not.toContain(S);
    });

    // F-8 (Medium): the preview styles every <redact> element (.prose-lumen redact), so the
    // author sees these passages shaded as "will be removed", but the export keeps them.
    for (const md of [`a <redact class="x">${S}</redact> b`, `a <redact\tid=1>${S}</redact> b`, `a <redact/>${S} b`]) {
      it(`(F-8) ${JSON.stringify(md.slice(0, 22))}… fails closed`, () => {
        expect(exp(md)).not.toContain(S);
      });
    }

    // F-9 (Medium): "Redact selection" over a selection that ends past an existing
    // </redact> ("Dana</redact> at Cafe X") leaves the rest of the selection in every export.
    it("wrapping a selection that contains a closing mark leaves none of it behind (F-9)", () => {
      const sel = `first part</redact>${S}`;
      const md = `x ${r.wrapRedaction(sel)} y`;
      const out = r.removeRedacted(md).text;
      expect(out).not.toContain(S);
      expect(out).not.toContain("first part");
    });
  });

  describe("the door (R9, R10)", () => {
    it("prepareForExport, the sync form and exportReadyText remove passages and comments; the note is unchanged", async () => {
      const md = `# t\n<redact>${S}</redact>\n<!-- ${S} -->\n%%${S}%%\nok`;
      const copy = md.slice();
      const a = await r.prepareForExport(md, { keepImageMetadata: false });
      expect(a.text).not.toContain(S);
      expect(a.report.redacted).toBe(1);
      expect(exp(md)).not.toContain(S);
      expect(await door!.exportReadyText(md)).not.toContain(S);
      expect(md).toBe(copy);
    });

    function jpegWithGps(): Uint8Array {
      // SOI, APP1 "Exif\0\0" with a TIFF header and a marker string, then a tiny
      // valid JPEG body is not needed for the metadata check: DQT/SOF/SOS/EOI.
      const exif = [...new TextEncoder().encode("Exif\0\0II*\0\x08\0\0\0GPS-31.7767N-35.2345E")];
      const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
      const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(1)];
      const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00];
      const dht = [0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, ...new Array(15).fill(0), 0x00];
      const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9];
      return new Uint8Array([0xff, 0xd8, ...app1, ...dqt, ...sof, ...dht, ...sos]);
    }
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

    it("an inline photo with GPS leaves without it, or is withheld", () => {
      const md = `![p](data:image/jpeg;base64,${b64(jpegWithGps())})`;
      const out = exp(md);
      const m = /data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)/.exec(out);
      expect(m).not.toBeNull();
      const bytes = atob(m![1]);
      expect(bytes).not.toContain("GPS-31.7767N");
      expect(bytes).not.toContain("Exif");
    });

    it("an inline photo that can't be parsed is withheld", () => {
      const md = `![p](data:image/jpeg;base64,${b64(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3]))})`;
      expect(exp(md)).toContain(r.WITHHELD_IMAGE);
    });
  });
});
