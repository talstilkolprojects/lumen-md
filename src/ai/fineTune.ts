/**
 * Fine-tune pipeline (γ.5 / F3).
 *
 * Opt-in: a Pro user toggles "Train AI on my writing style" in
 * Settings; we read every `.md` from the last 90 days, slice into
 * 800-word chunks, build OpenAI's training-JSONL shape, upload, and
 * trigger a fine-tune job. Once the job lands, the resulting model
 * id is persisted in the user's entitlement row so subsequent
 * `chat()` calls can use it.
 *
 * Privacy posture: opt-in (default OFF), Pro-only, full transparency
 * — Settings shows the size of the training set + a one-click
 * "delete my fine-tune" button (P3-18 work tracked separately).
 *
 * Cost guard: the `OPENAI_FINE_TUNE_LIMIT_TOKENS` env var caps the
 * total tokens we'll upload (default 200_000) so a runaway notes
 * folder doesn't burn $50 unattended.
 */

import { listWorkspace, readWorkspaceFile } from "../storage/workspace";
import { getAiKey, AiError } from "./llm";
import { assertCloudAllowed } from "./policy";
import { log } from "../lib/logger";
import { fetchWithRetry } from "../lib/fetchRetry";

/** OpenAI's job statuses; the first three are still in progress. */
export type FineTuneStatus = "validating_files" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

const FINISHED: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

/** Is the job still in progress? Anything not finished counts (an unknown new status too), so its id is never dropped early. */
export function fineTuneJobActive(status: string | undefined | null): boolean {
  return !!status && !FINISHED.has(status);
}

export interface FineTuneJob {
  id: string;
  status: FineTuneStatus;
  /** Resulting model id when status === "succeeded". */
  fineTunedModel?: string;
  /** Created-at unix timestamp (ms). */
  createdAt: number;
}

export interface FineTuneOptions {
  /** Look-back window for collecting training data, in days. Default 90. */
  windowDays?: number;
  /** Approx target token cap on the upload. Default 200_000. */
  maxTokens?: number;
  /** OpenAI base model to fine-tune. Default `gpt-4o-mini-2024-07-18`. */
  baseModel?: string;
  /** AbortSignal. */
  signal?: AbortSignal;
}

const DEFAULT_BASE_MODEL = "gpt-4o-mini-2024-07-18";
const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_WINDOW_DAYS = 90;
const CHUNK_WORDS = 800;
// Rough token-per-word ratio for English prose. Used only for the
// upload-cost guard; the OpenAI tokeniser is the authoritative count.
const TOKENS_PER_WORD = 1.3;

/**
 * Walk the workspace + emit a JSONL string suitable for upload to
 * `POST /v1/files`. Each chunk produces one fine-tuning training
 * sample with the user's writing style as the assistant turn.
 *
 * Exported pure for testability — the upload path glues this with
 * `fetch`.
 */
export async function buildTrainingJsonl(
  opts: FineTuneOptions = {},
): Promise<{ jsonl: string; chunks: number; estimatedTokens: number }> {
  const window = (opts.windowDays ?? DEFAULT_WINDOW_DAYS) * 86_400_000;
  const cap = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const since = Date.now() - window;

  const files = await listWorkspace({ includeAssets: false });
  const recent = files.filter(
    (f) => /\.(md|markdown)$/i.test(f.path) && (f.modified ?? 0) >= since,
  );

  const lines: string[] = [];
  let estimatedTokens = 0;

  outer: for (const f of recent) {
    let body: string;
    try {
      body = await readWorkspaceFile(f.path);
    } catch {
      continue;
    }
    // Strip frontmatter so we don't train on YAML.
    const stripped = body.replace(/^---\n[\s\S]*?\n---\n/, "");
    const words = stripped.split(/\s+/).filter(Boolean);
    if (words.length < CHUNK_WORDS / 2) continue;
    for (let i = 0; i + CHUNK_WORDS <= words.length; i += CHUNK_WORDS) {
      const chunk = words.slice(i, i + CHUNK_WORDS).join(" ");
      // Train: given the first half as a prompt, predict the second.
      const half = Math.floor(chunk.length / 2);
      const prompt = chunk.slice(0, half);
      const completion = chunk.slice(half);
      const sample = {
        messages: [
          {
            role: "system",
            content:
              "Continue the user's writing in their personal voice. Match their tone, vocabulary, and sentence length.",
          },
          { role: "user", content: prompt },
          { role: "assistant", content: completion },
        ],
      };
      lines.push(JSON.stringify(sample));
      estimatedTokens += Math.ceil(chunk.split(/\s+/).length * TOKENS_PER_WORD);
      if (estimatedTokens > cap) break outer;
    }
  }

  return {
    jsonl: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
    chunks: lines.length,
    estimatedTokens,
  };
}

/**
 * Upload the JSONL file to OpenAI Files. Returns the file id used by
 * the subsequent fine-tuning job.
 */
export async function uploadTrainingFile(
  jsonl: string,
  opts: FineTuneOptions = {},
): Promise<string> {
  assertCloudAllowed("OpenAI fine-tuning (uploads your writing)");
  const key = getAiKey();
  if (!jsonl.trim()) {
    throw new AiError("PARSE_ERROR", "No training data to upload — write more notes in the last 90 days.");
  }
  const blob = new Blob([jsonl], { type: "application/jsonl" });
  const form = new FormData();
  form.append("file", blob, "lumen-fine-tune.jsonl");
  form.append("purpose", "fine-tune");
  const res = await fetchWithRetry(
    "https://api.openai.com/v1/files",
    {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: opts.signal,
    },
    { label: "openai.fineTune.upload", maxRetries: 2, baseDelayMs: 700 },
  );
  if (!res.ok) {
    throw new AiError(
      "API_ERROR",
      `files upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new AiError("PARSE_ERROR", "OpenAI files response missing `id`");
  return json.id;
}

/**
 * Trigger a fine-tune job + return the initial job record. Poll
 * `getFineTuneJob(id)` to track progress.
 */
export async function createFineTuneJob(
  trainingFileId: string,
  opts: FineTuneOptions = {},
): Promise<FineTuneJob> {
  assertCloudAllowed("OpenAI fine-tuning");
  const key = getAiKey();
  const res = await fetchWithRetry(
    "https://api.openai.com/v1/fine_tuning/jobs",
    {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      training_file: trainingFileId,
      model: opts.baseModel ?? DEFAULT_BASE_MODEL,
      }),
    signal: opts.signal,
    },
    { label: "openai.fineTune.create", maxRetries: 2, baseDelayMs: 700 },
  );
  if (!res.ok) {
    throw new AiError(
      "API_ERROR",
      `OpenAI fine_tuning.jobs.create failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    id: string;
    status: FineTuneJob["status"];
    fine_tuned_model?: string;
    created_at: number;
  };
  return {
    id: json.id,
    status: json.status,
    fineTunedModel: json.fine_tuned_model,
    createdAt: json.created_at * 1000,
  };
}

/** Poll a job's current status. */
export async function getFineTuneJob(jobId: string): Promise<FineTuneJob> {
  assertCloudAllowed("OpenAI fine-tuning");
  const key = getAiKey();
  const res = await fetchWithRetry(
    `https://api.openai.com/v1/fine_tuning/jobs/${jobId}`,
    {
      headers: { Authorization: `Bearer ${key}` },
    },
    { label: "openai.fineTune.status", maxRetries: 2, baseDelayMs: 700 },
  );
  if (!res.ok) {
    throw new AiError(
      "API_ERROR",
      `OpenAI fine_tuning.jobs.retrieve failed (${res.status})`,
    );
  }
  const json = (await res.json()) as {
    id: string;
    status: FineTuneJob["status"];
    fine_tuned_model?: string;
    created_at: number;
  };
  return {
    id: json.id,
    status: json.status,
    fineTunedModel: json.fine_tuned_model,
    createdAt: json.created_at * 1000,
  };
}

/**
 * End-to-end orchestrator. Builds JSONL → uploads → creates job →
 * returns the initial job record. Caller polls.
 */
export async function startFineTune(
  opts: FineTuneOptions = {},
): Promise<FineTuneJob & { chunks: number; estimatedTokens: number }> {
  assertCloudAllowed("OpenAI fine-tuning (uploads your writing)");
  const built = await buildTrainingJsonl(opts);
  log.info("fine-tune training set built", {
    chunks: built.chunks,
    estimatedTokens: built.estimatedTokens,
  });
  if (built.chunks === 0) {
    throw new AiError(
      "PARSE_ERROR",
      "Not enough recent writing to fine-tune. Write at least a few thousand words in the last 90 days.",
    );
  }
  const fileId = await uploadTrainingFile(built.jsonl, opts);
  const job = await createFineTuneJob(fileId, opts);
  return { ...job, chunks: built.chunks, estimatedTokens: built.estimatedTokens };
}
