/**
 * Plan W3.2 — errors in words a person can act on: explainError() never
 * shows an error's own text (message, stack, code), says what happened and
 * what to do, logs the raw text, and shows nothing for a cancel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { errorKind, explainError, isCancel, UserFacingError } from "../lib/userError";
import { log } from "../lib/logger";
import { t } from "../i18n";

const dom = (name: string, message = "x") => Object.assign(new Error(message), { name });

const CASES: [unknown, string][] = [
  [dom("AbortError"), "cancelled"],
  [dom("QuotaExceededError", "The quota has been exceeded."), "quota"],
  [dom("NotAllowedError", "The request is not allowed by the user agent"), "permission"],
  [new TypeError("Failed to fetch"), "network"],
  [new Error("HTTP 503 Service Unavailable"), "network"],
  [dom("TimeoutError", "signal timed out"), "timeout"],
  [dom("NotFoundError", "A requested file or directory could not be found"), "notFound"],
  [new SyntaxError("Unexpected token < in JSON at position 0"), "badFile"],
  [dom("WorkspaceConflictError", '"a.md" already exists'), "conflict"],
  [new Error("HTTP 429 Too Many Requests"), "rateLimit"],
  [Object.assign(new Error("no key"), { name: "AiError", code: "NO_KEY" }), "aiNoKey"],
  [dom("PrivacyBlockedError", "Blocked by the local-only AI policy"), "aiPolicy"],
  [dom("NoLocalModelError"), "noLocalModel"],
  [dom("ResearchUnavailableError"), "unavailable"],
  [new Error("undefined is not a function"), "unknown"],
  ["a string", "unknown"],
  [42, "unknown"],
];

describe("errorKind", () => {
  it.each(CASES)("%s → %s", (e, kind) => {
    expect(errorKind(e)).toBe(kind);
  });
});

describe("explainError", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("never shows the raw message, stack or name; one sentence per kind", () => {
    const e = new TypeError("Cannot read properties of undefined (reading 'x')");
    const shown = explainError(e);
    expect(shown).toBe(t("error.unknown"));
    expect(shown).not.toContain("Cannot read");
    expect(shown).not.toContain("TypeError");
    expect(shown).not.toMatch(/\bat \w+ \(|\.ts:\d+/);
  });

  it("logs the raw text for the Doctor and bug reports", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    explainError(new Error("ENOENT: no such file"), "file.open");
    expect(warn).toHaveBeenCalledWith("[file.open] Error: ENOENT: no such file");
  });

  it("shows nothing for a cancel the person did", () => {
    expect(explainError(dom("AbortError"))).toBe("");
    expect(isCancel(dom("AbortError"))).toBe(true);
  });

  it("a UserFacingError is already written for the person: shown as it is", () => {
    expect(explainError(new UserFacingError("בחרו קובץ קודם."))).toBe("בחרו קובץ קודם.");
  });

  it("every message says what happened and what to do (two clauses at least)", () => {
    for (const kind of ["quota", "permission", "network", "timeout", "notFound", "badFile", "conflict", "rateLimit", "aiNoKey", "aiPolicy", "noLocalModel", "unknown"]) {
      const s = t(`error.${kind}`);
      expect(s, kind).not.toBe(`error.${kind}`);
      expect(s.split(/[.;]/).filter((x) => x.trim()).length, kind).toBeGreaterThanOrEqual(2);
    }
  });
});
