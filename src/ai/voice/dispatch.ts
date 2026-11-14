/**
 * Plan W5.20 — runs a parsed voice intent (./intents.ts): one palette
 * command, with the slot where the intent has one, after a confirmation
 * when the intent removes something. The effects come in as `deps`, so the
 * rules are tested without the app.
 */
import type { Intent } from "./intents";

export interface IntentDeps {
  /** Run a palette command by id (App listens for "lumen-run-command"). */
  runCommand(id: string): void;
  /** Ask before a destructive intent; true = go ahead. */
  confirm(intent: Intent): Promise<boolean>;
  /** Append a line to the inbox (quick capture, 4.16). */
  capture(text: string): Promise<unknown>;
  /** Insert text into the open note (as dictation does). */
  insert(text: string): void;
  /** Put the spoken query into the search box. */
  searchFor(query: string): void;
}

export type IntentOutcome = "ran" | "cancelled";

export async function runIntent(intent: Intent, deps: IntentDeps): Promise<IntentOutcome> {
  if (intent.confirm && !(await deps.confirm(intent))) return "cancelled";
  switch (intent.id) {
    case "add-task":
      // A task with words goes to the inbox as a checkbox; without them, the tasks panel opens.
      if (intent.slot) await deps.capture(`- [ ] ${intent.slot}`);
      else deps.runCommand(intent.command);
      return "ran";
    case "new-note":
      deps.runCommand(intent.command);
      if (intent.slot) deps.insert(`# ${intent.slot}\n\n`);
      return "ran";
    case "search":
      deps.runCommand(intent.command);
      if (intent.slot) deps.searchFor(intent.slot);
      return "ran";
    default:
      deps.runCommand(intent.command);
      return "ran";
  }
}
