/**
 * Feedback without a server (plan 14.2). Lumen has no feedback backend:
 * the dialog turns what the user wrote into the text of a GitHub issue,
 * which the user either opens on github.com (a new tab with the issue form
 * filled in) or copies. Nothing is sent by this module or by the dialog —
 * the only way out is the user's own click on "Open on GitHub" or "Copy".
 *
 * What can go in, each part only when the user ticks it:
 *  - app and browser details (version, platform, language, AI policy);
 *  - the AI doctor's report (checks of the local AI stack — no note text,
 *    and scrubbed of keys, passwords in URLs and e-mail addresses);
 *  - a screenshot, which never goes into the text: it is saved to the
 *    user's disk for them to attach to the issue by hand.
 */

import { version as appVersion } from "../../package.json";

export type FeedbackKind = "bug" | "idea" | "question";

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ["bug", "idea", "question"];

/** Where issues go: the project's public repository. */
export const FEEDBACK_REPO = "talstilkol/lumen-md";

/** GitHub's issue labels for each kind. */
const LABELS: Record<FeedbackKind, string> = { bug: "bug", idea: "enhancement", question: "question" };

/**
 * Longest issue URL we open. Browsers and GitHub accept more, but a long
 * prefilled URL is truncated or refused somewhere along the way; past this
 * the URL carries only the title and the user pastes the copied body.
 */
export const MAX_ISSUE_URL = 7500;

export interface FeedbackEnvironment {
  version: string;
  /** "web", "installed web app" or "desktop". */
  shell: string;
  platform: string;
  language: string;
  userAgent: string;
  aiPolicy: string;
}

export interface FeedbackInput {
  kind: FeedbackKind;
  title: string;
  description: string;
  /** App and browser details, when the user agreed to include them. */
  environment?: FeedbackEnvironment | null;
  /** The AI doctor's plain-text report, when the user agreed to include it. */
  doctorReport?: string | null;
  /** The user saved a screenshot to attach by hand. */
  screenshot?: boolean;
}

/** Headings of the issue body (English: issues are read by the maintainers). */
const HEADINGS = {
  description: "## What happened",
  environment: "## Environment",
  doctor: "## AI doctor report",
  screenshot: "## Screenshot",
};

const KIND_PREFIX: Record<FeedbackKind, string> = { bug: "Bug", idea: "Idea", question: "Question" };

/** The details this device can report, without reading any note. */
export function collectEnvironment(aiPolicy: string, nav: Pick<Navigator, "userAgent" | "language" | "platform"> = navigator, win: { matchMedia?: (q: string) => { matches: boolean } } & object = window): FeedbackEnvironment {
  const desktop = "__TAURI_INTERNALS__" in win;
  const installed = !desktop && !!win.matchMedia?.("(display-mode: standalone)").matches;
  return {
    version: appVersion,
    shell: desktop ? "desktop" : installed ? "installed web app" : "web",
    platform: nav.platform || "unknown",
    language: nav.language || "unknown",
    userAgent: nav.userAgent,
    aiPolicy,
  };
}

/**
 * Remove what must not leave in a report even with consent: API keys and
 * bearer tokens, passwords inside URLs, query-string secrets, e-mail
 * addresses. The doctor report holds no note text to begin with; this is
 * the second line of defence for whatever its details quote (URLs, errors).
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|AIza)[-_A-Za-z0-9]{12,}/g, "[redacted key]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:key|token|access_token|api_key|apikey|secret|password|sig|signature)=)[^&\s#]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted e-mail]");
}

/** The issue title as it will appear on GitHub. */
export function feedbackTitle(input: Pick<FeedbackInput, "kind" | "title">): string {
  const title = input.title.replace(/\s+/g, " ").trim();
  return `${KIND_PREFIX[input.kind]}: ${title || "(no title)"}`;
}

/** The issue body: exactly the text the preview shows and the user sends. */
export function feedbackBody(input: FeedbackInput): string {
  const parts: string[] = [HEADINGS.description, "", input.description.trim() || "_(no description)_"];
  const env = input.environment;
  if (env) {
    parts.push(
      "",
      HEADINGS.environment,
      "",
      `- Lumen ${env.version} (${env.shell})`,
      `- Platform: ${env.platform} · language: ${env.language}`,
      `- AI policy: ${env.aiPolicy}`,
      `- Browser: ${env.userAgent}`,
    );
  }
  const report = input.doctorReport?.trim();
  if (report) parts.push("", HEADINGS.doctor, "", "```text", scrubSecrets(report).replace(/```/g, "ʼʼʼ"), "```");
  if (input.screenshot) parts.push("", HEADINGS.screenshot, "", "_(attached by hand)_");
  return parts.join("\n") + "\n";
}

export interface IssueLink {
  url: string;
  /** False when the body did not fit: the URL has the title only, and the user pastes the body. */
  withBody: boolean;
}

/** github.com's "new issue" form, filled in. */
export function issueLink(input: FeedbackInput, repo = FEEDBACK_REPO): IssueLink {
  const base = `https://github.com/${repo}/issues/new`;
  const q = (body?: string) => {
    const p = new URLSearchParams({ title: feedbackTitle(input), labels: LABELS[input.kind] });
    if (body !== undefined) p.set("body", body);
    return `${base}?${p.toString()}`;
  };
  const full = q(feedbackBody(input));
  if (full.length <= MAX_ISSUE_URL) return { url: full, withBody: true };
  return { url: q(), withBody: false };
}

/** The same feedback as one block of text, for e-mail or anywhere else. */
export function feedbackText(input: FeedbackInput): string {
  return `# ${feedbackTitle(input)}\n\n${feedbackBody(input)}`;
}

/** A file name for the saved screenshot. */
export function screenshotFileName(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `lumen-feedback-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.png`;
}
