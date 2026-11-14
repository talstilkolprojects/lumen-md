/**
 * 14.2 — feedback without a server: the issue text, the GitHub link and the
 * scrubbing of what must never leave even with consent.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  MAX_ISSUE_URL,
  collectEnvironment,
  feedbackBody,
  feedbackText,
  feedbackTitle,
  issueLink,
  scrubSecrets,
  screenshotFileName,
  type FeedbackInput,
} from "../feedback/feedback";
import { version } from "../../package.json";

const NAV = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0", language: "he-IL", platform: "Linux x86_64" };
const WEB = { matchMedia: () => ({ matches: false }) };

const base: FeedbackInput = { kind: "bug", title: "  Tabs   vanish ", description: "I closed one tab and all went." };

describe("feedback (14.2)", () => {
  it("titles the issue by kind", () => {
    expect(feedbackTitle(base)).toBe("Bug: Tabs vanish");
    expect(feedbackTitle({ kind: "idea", title: "" })).toBe("Idea: (no title)");
    expect(feedbackTitle({ kind: "question", title: "Sync?" })).toBe("Question: Sync?");
  });

  it("the body holds only what the user wrote unless more was ticked", () => {
    const body = feedbackBody(base);
    expect(body).toContain("I closed one tab and all went.");
    expect(body).not.toContain("## Environment");
    expect(body).not.toContain("## AI doctor report");
    expect(body).not.toContain("## Screenshot");
  });

  it("environment, doctor report and screenshot note appear only when included", () => {
    const env = collectEnvironment("local-only", NAV, WEB);
    expect(env).toEqual({ version, shell: "web", platform: "Linux x86_64", language: "he-IL", userAgent: NAV.userAgent, aiPolicy: "local-only" });
    const body = feedbackBody({ ...base, environment: env, doctorReport: "✓ AI policy — local-only", screenshot: true });
    expect(body).toContain(`- Lumen ${version} (web)`);
    expect(body).toContain("- AI policy: local-only");
    expect(body).toContain("## AI doctor report\n\n```text\n✓ AI policy — local-only\n```");
    expect(body).toContain("## Screenshot\n\n_(attached by hand)_");
  });

  it("knows the installed app and the desktop shell", () => {
    expect(collectEnvironment("cloud", NAV, { matchMedia: () => ({ matches: true }) }).shell).toBe("installed web app");
    const desktop = { ...WEB, __TAURI_INTERNALS__: {} };
    expect(collectEnvironment("cloud", NAV, desktop).shell).toBe("desktop");
  });

  it("scrubs keys, tokens, URL passwords, query secrets and e-mail addresses from the report", () => {
    const dirty = [
      "Authorization: Bearer abcdefghijklmnop1234",
      "key sk-proj-AbCdEfGhIjKlMnOpQrSt",
      "ghp_0123456789abcdefghijABCD",
      "http://tal:hunter2@192.168.1.5:11434/api/tags",
      "https://example.com/search?q=x&key=SECRET123&lang=he",
      "contact tal@example.com",
    ].join("\n");
    const clean = scrubSecrets(dirty);
    for (const leak of ["abcdefghijklmnop1234", "AbCdEfGhIjKlMnOpQrSt", "ghp_0123", "hunter2", "SECRET123", "tal@example.com"]) expect(clean).not.toContain(leak);
    expect(clean).toContain("http://[redacted]@192.168.1.5:11434/api/tags");
    expect(clean).toContain("?q=x&key=[redacted]&lang=he");
    // Ordinary report lines are untouched.
    expect(scrubSecrets("✓ Ollama — http://localhost:11434 · v0.6.2 (12 ms)")).toBe("✓ Ollama — http://localhost:11434 · v0.6.2 (12 ms)");
    // …and the scrub is applied to the report inside the body.
    expect(feedbackBody({ ...base, doctorReport: "Bearer abcdefghijklmnop1234" })).not.toContain("abcdefghijklmnop1234");
  });

  it("a report cannot close the code block early", () => {
    const body = feedbackBody({ ...base, doctorReport: "line\n```\n# injected heading" });
    expect(body.match(/```/g)).toHaveLength(2);
  });

  it("links to GitHub's new-issue form with title, body and label", () => {
    const link = issueLink(base);
    expect(link.withBody).toBe(true);
    const u = new URL(link.url);
    expect(`${u.origin}${u.pathname}`).toBe("https://github.com/talstilkol/lumen-md/issues/new");
    expect(u.searchParams.get("title")).toBe("Bug: Tabs vanish");
    expect(u.searchParams.get("labels")).toBe("bug");
    expect(u.searchParams.get("body")).toBe(feedbackBody(base));
    expect(new URL(issueLink({ ...base, kind: "idea" }).url).searchParams.get("labels")).toBe("enhancement");
  });

  it("falls back to title only when the body is too long for a URL", () => {
    const long = issueLink({ ...base, description: "x".repeat(MAX_ISSUE_URL) });
    expect(long.withBody).toBe(false);
    expect(long.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    expect(new URL(long.url).searchParams.has("body")).toBe(false);
    // Hebrew text percent-encodes to ~6 bytes a letter: still judged by the encoded length.
    const he = issueLink({ ...base, description: "א".repeat(1300) });
    expect(he.withBody).toBe(false);
  });

  it("the copy text is title + body", () => {
    expect(feedbackText(base)).toBe(`# Bug: Tabs vanish\n\n${feedbackBody(base)}`);
  });

  it("names the screenshot by time", () => {
    expect(screenshotFileName(new Date(2026, 10, 9, 7, 5, 3))).toBe("lumen-feedback-20261109-070503.png");
  });
});
