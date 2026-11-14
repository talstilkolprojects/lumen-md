/** Plan 12.4 — what an error report may carry: no message text, titles, paths or user data. */
import { describe, it, expect } from "vitest";
import type { ErrorEvent } from "@sentry/browser";
import { scrubEvent, scrubFilename, scrubType } from "../lib/monitoringScrub";

describe("scrubType", () => {
  it("keeps error class names and replaces anything else", () => {
    expect(scrubType("TypeError")).toBe("TypeError");
    expect(scrubType("WorkspaceConflictError")).toBe("WorkspaceConflictError");
    expect(scrubType("Quarterly plan")).toBe("Error");
    expect(scrubType("יומן")).toBe("Error");
    expect(scrubType(undefined)).toBe("Error");
  });
});

describe("scrubFilename", () => {
  it("keeps only a script's file name", () => {
    expect(scrubFilename("https://lumen-md.vercel.app/assets/app-AbC12.js?v=1#x")).toBe("app-AbC12.js");
    expect(scrubFilename("/Users/tal/My Notes/x.js")).toBe("x.js");
    expect(scrubFilename("file:///home/tal/יומן.md")).toBe("[file]");
    expect(scrubFilename(undefined)).toBeUndefined();
  });
});

describe("scrubEvent", () => {
  it("rebuilds the event from an allowlist: class name and stack frames, no message", () => {
    const event = {
      type: undefined,
      event_id: "e1",
      level: "error",
      release: "lumen@0.1.0",
      message: "Could not open Diary",
      logentry: { message: "Could not open %s", params: ["Diary"] },
      request: { url: "https://lumen-md.vercel.app/#/notes/diary.md", headers: { Referer: "x" } },
      user: { id: "u1", ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: "typed: my secret" }],
      tags: { doc: "diary.md" },
      extra: { note: "the body of my note" },
      contexts: { state: { doc: "the body" } },
      transaction: "/notes/diary.md",
      exception: {
        values: [
          {
            type: "Error",
            // Unquoted user text: no pattern could tell it from the app's own words.
            value: "Failed to save Quarterly plan to notes/diary.md",
            mechanism: { type: "generic", handled: true, data: { path: "notes/diary.md" } },
            stacktrace: {
              frames: [{ filename: "https://lumen-md.vercel.app/assets/app-1.js", function: "save", lineno: 3, colno: 9, context_line: "const secret = 1", vars: { text: "body" }, abs_path: "/x/y" }],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;
    const out = scrubEvent(event);
    expect(out).toEqual({
      type: undefined,
      event_id: "e1",
      level: "error",
      release: "lumen@0.1.0",
      exception: {
        values: [
          {
            type: "Error",
            mechanism: { type: "generic", handled: true },
            stacktrace: { frames: [{ filename: "app-1.js", function: "save", lineno: 3, colno: 9 }] },
          },
        ],
      },
    });
    expect(JSON.stringify(out)).not.toMatch(/Quarterly|Diary|diary|secret|body|1\.2\.3\.4|u1/);
  });

  it("drops an event that has only a message", () => {
    expect(scrubEvent({ type: undefined, message: "Failed to save Quarterly plan" } as ErrorEvent)).toBeNull();
  });
});
