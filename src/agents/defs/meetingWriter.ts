/**
 * meeting-writer (plan 6.16) — from a meeting's transcript: the decisions,
 * the tasks with their owner and due date, and the open questions. JSON
 * output checked against the schema; dates must be real YYYY-MM-DD dates
 * (relative ones — "next Tuesday" — resolved from the meeting's date).
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { clip, fail, ok } from "./shared";
import { isIsoDate } from "../../meetings/meetingCore";

export interface MeetingWriterInput extends AgentInput {
  /** The transcript. */
  text: string;
  /** `date`: the meeting's date (YYYY-MM-DD), for relative due dates. */
  extra: { date: string };
}

export interface MeetingWriterOutput {
  decisions: string[];
  tasks: Array<{ text: string; owner?: string; due?: string }>;
  questions: string[];
}

export const MEETING_MAX_CHARS = 24_000;

export const meetingWriterAgent: AgentDefinition<MeetingWriterInput, MeetingWriterOutput> = registerAgent<MeetingWriterInput, MeetingWriterOutput>({
  id: "meeting-writer",
  commandId: "voice.meeting",
  description: "Meeting notes from a transcript: decisions, tasks with owner and date, open questions",
  system: (input) =>
    `You take notes of a meeting held on ${input.extra.date}, from its transcript. Write in the transcript's language. ` +
    "List: the decisions that were made; every task someone agreed to do (one item per task, starting with a verb), with its owner when named and its due date when one was said — " +
    `as YYYY-MM-DD, working out relative dates ("tomorrow", "next Tuesday") from ${input.extra.date}; and the questions left open. ` +
    "Leave out small talk. Do not invent owners or dates. " +
    'Output ONLY JSON: {"decisions": ["..."], "tasks": [{"text": "...", "owner": "...", "due": "YYYY-MM-DD"}], "questions": ["..."]} — omit "owner" or "due" when not said.',
  user: (input) => clip(input.text, MEETING_MAX_CHARS),
  outputSchema: {
    type: "object",
    properties: {
      decisions: { type: "array", maxItems: 30, items: { type: "string", minLength: 1 } },
      tasks: {
        type: "array",
        maxItems: 50,
        items: { type: "object", properties: { text: { type: "string", minLength: 1 }, owner: { type: "string" }, due: { type: "string" } }, required: ["text"] },
      },
      questions: { type: "array", maxItems: 30, items: { type: "string", minLength: 1 } },
    },
    required: ["decisions", "tasks", "questions"],
  },
  validators: [
    {
      name: "dates",
      check: (out) => {
        const bad = out.tasks.filter((t) => t.due !== undefined && t.due !== "" && !isIsoDate(t.due));
        return bad.length ? fail(`due dates that are not YYYY-MM-DD dates: ${bad.map((t) => JSON.stringify(t.due)).join(", ")}`, "Give each due date as YYYY-MM-DD, or leave it out.") : ok;
      },
    },
  ],
  language: "any",
  maxRetries: 1,
  tier: "medium",
  temperature: 0,
  maxTokens: 1500,
});
