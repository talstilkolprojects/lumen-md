/**
 * "Ask the law" with an answer (plan W10.B10, audit W7.5, plan 5.6's
 * critic). askTheLaw (./store.ts) only finds and quotes sections. When a
 * local model is available, this writes a short answer from one section and
 * then has a critic check the answer against that section's text. An answer
 * is `verified` only when the critic says the section supports it. There is
 * no other way for an answer to be verified.
 *
 * The critic has two parts, and both must pass:
 *   1. deterministic: every number in the answer (days, years, amounts,
 *      section numbers) must appear in the section. A number the section
 *      doesn't have is a contradiction, whatever the model says.
 *   2. the model, asked separately: does the section SUPPORT the claim,
 *      CONTRADICT it, or not say (NOT_ENOUGH)?
 */
import type { LawAnswer } from "./store";

/** A chat call to a local model: messages in, the reply's text out. */
export type LawChat = (messages: Array<{ role: "system" | "user"; content: string }>) => Promise<string>;

export type CriticVerdict = "supported" | "contradicted" | "unsupported" | "no-critic";

export interface LawClaimAnswer {
  kind: "answer";
  question: string;
  claim: string;
  quote: LawAnswer;
  critic: CriticVerdict;
  /** True only when the critic found the claim supported by the quoted section. */
  verified: boolean;
}

/** Numbers in `claim` (digits, with Hebrew letters stuck to them as in 7א) that the section does not contain. */
export function numbersNotInSection(claim: string, section: string): string[] {
  const inSection = new Set(section.match(/\d+(?:[.,]\d+)?/g) ?? []);
  return [...new Set(claim.match(/\d+(?:[.,]\d+)?/g) ?? [])].filter((n) => !inSection.has(n));
}

const CRITIC_SYSTEM =
  "You check an answer against one section of an Israeli law. Reply with exactly one word: SUPPORTED if the section " +
  "states what the answer says, CONTRADICTED if the section says otherwise, NOT_ENOUGH if the section does not say.";

/** The critic: deterministic numbers first, then the model. Without a model there is no critic. */
export async function criticCheck(claim: string, sectionText: string, chat: LawChat | null): Promise<CriticVerdict> {
  if (!chat) return "no-critic";
  if (numbersNotInSection(claim, sectionText).length) return "contradicted";
  let reply: string;
  try {
    reply = await chat([
      { role: "system", content: CRITIC_SYSTEM },
      { role: "user", content: `Section:\n${sectionText}\n\nAnswer:\n${claim}` },
    ]);
  } catch {
    return "unsupported";
  }
  const word = reply.trim().toUpperCase();
  if (word.startsWith("SUPPORTED")) return "supported";
  if (word.startsWith("CONTRADICTED")) return "contradicted";
  return "unsupported";
}

const ANSWER_SYSTEM =
  "Answer the question in one or two sentences, in the question's language, using ONLY the law section given. " +
  "If the section does not answer it, say so.";

/**
 * An answer from one quoted section, checked by the critic. Null without a
 * model: then there is only the quote.
 */
export async function answerLawQuestion(question: string, quote: LawAnswer, chat: LawChat | null): Promise<LawClaimAnswer | null> {
  if (!chat) return null;
  const sectionText = `${quote.section.number}. ${quote.section.text}`;
  let claim: string;
  try {
    claim = (await chat([
      { role: "system", content: ANSWER_SYSTEM },
      { role: "user", content: `Law: ${quote.law.law.name}\nSection ${sectionText}\n\nQuestion: ${question}` },
    ])).trim();
  } catch {
    return null;
  }
  if (!claim) return null;
  const critic = await criticCheck(claim, sectionText, chat);
  return { kind: "answer", question, claim, quote, critic, verified: critic === "supported" };
}
