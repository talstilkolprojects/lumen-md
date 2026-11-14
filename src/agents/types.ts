/**
 * Lumen local agents — shared types.
 *
 * An *agent* is a definition: what to ask the model, which tools it may
 * call, what shape the answer must have and how to check it. The *runtime*
 * (`runtime.ts`) runs a definition against an *executor* (Ollama, in-browser
 * WebGPU, …): it loops over tool calls, parses and validates the answer,
 * and when there is no usable answer it asks the *critic* (`critic.ts`)
 * what to change for a retry or what to suggest to the user.
 *
 * The model only proposes; tools execute; validators decide.
 */

/** A JSON Schema object (draft 7 subset is enough for every executor). */
export type JsonSchema = Record<string, unknown>;

/**
 * What a tool may touch. `read` is always granted. `write` and `network`
 * need an explicit grant for the run, and the runtime adds its own rules:
 * a write tool only *stages* a change the user approves (`staging.ts`), a
 * network tool goes through the AI policy, the per-call consent and the
 * privacy ledger (`network.ts`).
 */
export type ToolScope = "read" | "write" | "network";

/** A change a write tool proposes; the runtime stages it, it is never applied directly. */
export type ChangeProposal =
  | {
      /** Create or overwrite a workspace file. `before` is the content the change was computed from (null: the file did not exist). */
      kind: "file";
      path: string;
      before: string | null;
      after: string;
      summary: string;
    }
  | {
      /** Replace [from, to) of the open document (UTF-16 offsets into the text the run received). */
      kind: "range";
      path: string | null;
      from: number;
      to: number;
      before: string;
      after: string;
      /** The text around the range when it was proposed, so a moved range (or an insertion) is found again or refused. */
      context?: RangeContext;
      summary: string;
      /**
       * Fingerprint of the whole text the offsets refer to (`textFingerprint`,
       * set by the runtime). When the text is still that one, or that one
       * with only approved changes applied since, the offsets are exact
       * (mapped through those changes), so several changes computed on the
       * same text can be approved in any order.
       */
      basis?: string;
      /**
       * Which open document the run worked on (an opaque key from the
       * editor, `agents/docKey.ts`, set by the runtime when the run starts).
       * A change with no `path` is applied only to that document — the
       * active one or another tab — never to whichever document is active.
       */
      docKey?: string;
    };

/** Up to 40 characters on each side of a proposed range (`staging.rangeContext`). */
export interface RangeContext {
  before: string;
  after: string;
  /** The context reaches the start / end of the document. */
  atStart: boolean;
  atEnd: boolean;
}

/** Why an approved change was not applied (shown, translated, in the review panel). */
export type StagedConflict =
  /** The file's content is no longer the content the change was computed from. */
  | "file-changed"
  /** The change creates a file, and one with that name appeared since. */
  | "file-created"
  /** The text the change replaces is no longer there (the document was edited since). */
  | "doc-changed"
  /** It overlaps another change from the same proposal that was approved first. */
  | "overlap"
  /** The file is open in the editor with edits the change was not computed from. */
  | "open-unsaved"
  /** The document it was proposed for is no longer open. */
  | "not-open"
  /** Applying failed (storage error and the like). */
  | "failed";

/** A staged change as the queue keeps it (see `staging.ts`). */
export type StagedChange = ChangeProposal & {
  id: string;
  tool: string;
  runId?: string;
  agentId?: string;
  createdAt: number;
  status: "pending" | "applied" | "rejected" | "conflict";
  /** Why it could not be applied (status `conflict`), or why it was withdrawn. */
  error?: string;
  /** Status `conflict`: the reason, as a code the UI translates. */
  conflict?: StagedConflict;
  /** Status `rejected`: the run that proposed it was cancelled (nobody rejected it). */
  withdrawn?: true;
  /**
   * Status `applied`: where it went — the document in the editor (unsaved
   * until the user saves; undo works in the source editor), another open
   * tab (unsaved), or a workspace file written directly.
   */
  appliedTo?: "document" | "tab" | "file";
  /**
   * Status `applied` to the document: the edit went in without an undo
   * history (the source editor was not showing it: Preview, WYSIWYG), so
   * Undo cannot take it back.
   */
  noUndo?: true;
  /** Applied as a tracked change (CriticMarkup) because suggesting mode was on. */
  asSuggestion?: true;
};

/** What a write tool returns: the receipt of the staged change, never the write itself. */
export interface StagedReceipt {
  staged: true;
  changeId: string;
  kind: ChangeProposal["kind"];
  path: string | null;
  summary: string;
}

/** A page `fetch_page` read in this run (so `extract_quotes` can quote it without resending the text). */
export interface FetchedPage {
  url: string;
  finalUrl: string;
  title?: string;
  text: string;
}

/** What a network tool is about to send, for the consent prompt and the ledger. */
export interface NetworkConsentRequest {
  tool: string;
  /** Host that receives the data: always the research service. */
  host: string;
  /** What leaves the device, in plain words ("the search query", "the page address") — for logs; the prompt uses `what`. */
  sends: string;
  /** The same, as a key the prompt translates. */
  what: "search-query" | "page-address" | "tool-args";
  /** A search provider whose API key goes along with the query (Brave, Tavily). */
  credential?: string;
  /** The page's host, which the research service then visits (fetch_page). */
  visits?: string;
  args: Record<string, unknown>;
  /** The run has untrusted content in its context (plan 2.7): the prompt warns about it. */
  untrusted?: string[];
}

/**
 * A write or network tool call in a run that has untrusted content in its
 * context (plan 2.7): it goes ahead only on the user's explicit approval.
 */
export interface UntrustedConsentRequest {
  tool: string;
  scope: "write" | "network";
  args: Record<string, unknown>;
  /** Where the untrusted content came from (pages, clipped / imported notes). */
  sources: string[];
  /** Network calls: exactly what is sent and where, as the network consent shows it. */
  network?: NetworkConsentRequest;
}

export interface ToolContext {
  signal?: AbortSignal;
  /** Workspace path of the active document, when there is one. */
  path?: string | null;
  /** The active document's full text (editor state, not the file on disk). */
  document?: string;
  /** The current editor selection. */
  selection?: string;
  /** Scopes the caller granted for this run. */
  grants: ReadonlySet<ToolScope>;
  /**
   * Write tools only, set by the runtime for the call: stages a proposal
   * and returns its receipt. Without it a write tool refuses to run.
   */
  stage?: (proposal: ChangeProposal) => StagedReceipt;
  /**
   * Network tools only, set by the runtime once the policy / consent gate
   * passed for this call: a fetch that the privacy ledger records. Without
   * it a network tool refuses to run.
   */
  fetch?: typeof fetch;
  /**
   * Network tools only, set with `fetch`: the research service and settings
   * the call was described with (and, under local-only, approved with). The
   * tool uses exactly these, never the settings as they are now.
   */
  network?: { endpoint: string; settings: import("../research/client").ResearchSettings };
  /** Pages fetched in this run, by URL (runtime-owned scratch). */
  pages?: Map<string, FetchedPage>;
  /** Why the open document / selection is untrusted (empty or unset: it isn't). */
  documentUntrusted?: string[];
}

export interface AgentTool<A = Record<string, unknown>, R = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;
  scope: ToolScope;
  run(args: A, ctx: ToolContext): Promise<R>;
  /**
   * Where the result's text came from when it is outside content (plan
   * 2.7): web pages, search results, clipped or imported notes. Empty: the
   * result is the user's own data. The runtime cleans and delimits such a
   * result before the model sees it, and from then on asks the user before
   * any write or network call of the run.
   */
  untrusted?(args: A, result: R, ctx: ToolContext): string[] | Promise<string[]>;
  /**
   * The tool itself comes from outside (an MCP server, plan W7.18): offering
   * it taints the run from its start, so every write or network call asks
   * the user (review 21, C1).
   */
  offeredBy?: string[];
  /** A network tool that talks to its own server (an MCP server's URL), not the research service (review 21, C2). */
  networkTarget?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** A message as executors see it: text, plus tool calls and tool results. */
export interface ExecutorMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant turn that requested tools. */
  toolCalls?: ToolCall[];
  /** Tool turn: which call this answers. */
  toolCallId?: string;
  /** Tool turn: the tool's name. */
  name?: string;
}

export type ModelTier = "tiny" | "small" | "medium" | "large";

export const MODEL_TIERS: readonly ModelTier[] = ["tiny", "small", "medium", "large"];

export interface ExecutorRequest {
  messages: ExecutorMessage[];
  /** A fixed sampling seed (the real-model CI run, plan 7.2): with temperature 0, the same answer every run. */
  seed?: number;
  /** false: ask a reasoning model (Qwen3, …) to answer without a thinking phase. Executors without the option ignore it. */
  think?: boolean;
  /** Tools the model may call this turn. */
  tools?: AgentTool[];
  /** When set, the answer must be JSON matching this schema. */
  schema?: JsonSchema;
  /** Pins a model; otherwise the executor picks one for `tier`. */
  model?: string;
  tier?: ModelTier;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Receives text deltas when the executor can stream. */
  onDelta?: (chunk: string) => void;
  /**
   * Charges the run's quota prompt (idempotent). The runtime calls it
   * before a native local executor's request; the chat adapter hands it to
   * chat(), which calls it at dispatch, after its key and rate-limit checks.
   */
  charge?: () => void;
}

export interface ExecutorUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export interface ExecutorResponse {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  usage?: ExecutorUsage;
}

export type ExecutorId = "ollama" | "webllm" | "transformers" | "chat";

export interface Availability {
  available: boolean;
  /** Stable reason code when unavailable (`ollama-offline`, `no-webgpu`, `cors`, …). */
  reason?: string;
  detail?: string;
}

export interface Executor {
  id: ExecutorId;
  label: string;
  available(): Promise<Availability>;
  chat(req: ExecutorRequest): Promise<ExecutorResponse>;
  /** Native tool calling (otherwise the runtime uses the JSON-ReAct protocol). */
  supportsTools(model?: string): boolean;
  /** Native JSON-schema constrained output. */
  supportsSchema(model?: string): boolean;
  /**
   * The model the executor would use for a tier (and, when the agent calls
   * tools, one that supports them natively if the device has one).
   */
  modelFor(tier: ModelTier, opts?: { tools?: boolean }): string;
}

export interface AgentInput {
  /** The main text the agent works on (document, selection, diff…). */
  text?: string;
  /** Workspace path of the document, when relevant. */
  path?: string | null;
  selection?: string;
  /** UI locale, so prompts can ask for the user's language. */
  locale?: string;
  /** Agent-specific extras (target language, instructions…). */
  extra?: Record<string, unknown>;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string; hint?: string };

/** What a validator may look at besides the output: the pages the run fetched (the researcher checks its quotes against them). */
export interface ValidationContext {
  pages: ReadonlyMap<string, FetchedPage>;
}

export interface Validator<O> {
  name: string;
  check(output: O, input: AgentInput, ctx?: ValidationContext): ValidationResult | Promise<ValidationResult>;
}

/** One change the critic proposes for a retry. */
export interface RetryPatch {
  model?: string;
  tier?: ModelTier;
  temperature?: number;
  /** Appended to the user message (e.g. the validator's error). */
  promptSuffix?: string;
  /** Replaces the system prompt for the retry. */
  systemOverride?: string;
  /** Try another executor. */
  executor?: ExecutorId;
  /**
   * Run the agent on parts of the input of at most this many characters and
   * merge the answers (plan 5.6.2, the "split the document" suggestion).
   */
  split?: number;
}

export type SuggestionAction =
  | { type: "retry"; patch: RetryPatch }
  | { type: "pull-model"; executor: ExecutorId; model: string }
  | { type: "switch-executor"; executor: ExecutorId }
  | { type: "set-policy"; policy: "local-only" | "local-first" | "cloud" }
  | { type: "open-docs"; key: string }
  | { type: "split-input" }
  /** Wait for Ollama to answer (the user starts it), checking live (plan 5.6.5). */
  | { type: "check-ollama" }
  /** Run another palette command (add a key, open settings). */
  | { type: "run-command"; id: string };

export interface Suggestion {
  id: string;
  /** i18n key for the title (the UI translates it) — or plain text when `raw`. */
  title: string;
  /** Title/detail are plain text (the model critic writes them), not i18n keys. */
  raw?: boolean;
  /** i18n key for the detail; `params` fill its placeholders. */
  detail?: string;
  params?: Record<string, string | number>;
  action?: SuggestionAction;
}

export interface AgentDefinition<I extends AgentInput = AgentInput, O = string> {
  id: string;
  /** Palette command this agent backs, for traces. */
  commandId?: string;
  description: string;
  system: string | ((input: I) => string);
  user: (input: I) => string;
  tools?: AgentTool[];
  /**
   * Tool calls the runtime makes for the agent before its first model turn
   * (plan 5.3): the context it always needs — the workspace's tags, the
   * note list, the diff — fetched through the runtime's tool path (scope
   * checks, argument schemas, the trace), never by importing the source
   * directly. The model sees each as a call it made, with its result, and
   * may call its tools again. Every name must be one of `tools`.
   */
  context?: (input: I) => Array<{ tool: string; args?: Record<string, unknown> }>;
  /** JSON output; the executor constrains it when it can. */
  outputSchema?: JsonSchema;
  /** Turns the model's final text into the output (default: JSON when a schema is set, else trimmed text). */
  parse?: (text: string, input: I) => O;
  validators?: Validator<O>[];
  /** Executors to try, in order. Default: the runtime's policy order. */
  executorPreference?: ExecutorId[];
  tier?: ModelTier;
  maxSteps?: number;
  /** Retries after a failed validation (default 2). Interactive agents set 0. */
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number | ((input: I) => number);
  /** Stream deltas to the caller (text agents). */
  streaming?: boolean;
  /**
   * The answer of a part of the input means the same as of the whole, so
   * the critic may offer "split the document" (5.6.2). Not for answers that
   * point into the input (line numbers) or are one artefact (a diagram).
   */
  splittable?: boolean;
  /** Scopes this agent needs beyond `read`. */
  requires?: ToolScope[];
  /**
   * Reuse an identical earlier answer from the local response cache (and
   * store this one once it validated). Only for deterministic
   * transformations of the given input; the user can turn the cache off.
   */
  cache?: boolean;
  /**
   * The language of the answer (T27). "input" (default): the same language
   * as the user's text — the runtime says so in the prompt and rejects a
   * prose answer in another script. "any": the agent decides (translation,
   * code, commit messages, chart and diagram syntax). A function decides
   * per input (a prompt template that asks for another language).
   */
  language?: "input" | "any" | ((input: I) => "input" | "any");
}

export type StepKind = "model" | "tool" | "validate" | "retry" | "critic" | "cache";

export interface AgentStep {
  kind: StepKind;
  at: number;
  ms: number;
  /** Tool name, validator name, retry reason… */
  label: string;
  ok: boolean;
  detail?: string;
}

export type RunStatus = "ok" | "failed" | "aborted";

export interface AgentRun<O = unknown> {
  id: string;
  agentId: string;
  commandId?: string;
  executor: ExecutorId | null;
  model: string | null;
  startedAt: number;
  endedAt: number;
  status: RunStatus;
  output?: O;
  /** Stable code when failed (`no-executor`, `validation`, `parse`, `tool`, `aborted`, `error`). */
  errorCode?: string;
  error?: string;
  attempts: number;
  steps: AgentStep[];
  suggestions: Suggestion[];
  tokens: { input: number; output: number; estimated: boolean };
  /** Key of the input (agent + user prompt): a retry picked in the panel applies to this input. */
  inputKey?: string;
  /** The run this one re-does: the user said its answer was not good (plan 5.6.3). */
  retryOf?: string;
  /** The user's verdict on this run's answer. */
  feedback?: "bad";
  /** Ids of the changes this run's write tools staged (waiting for approval in `staging.ts`). */
  staged?: string[];
  /** Sources of the untrusted content the run had in its context (plan 2.7). */
  untrusted?: string[];
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Scopes granted for this run (`read` is always granted). */
  grants?: ToolScope[];
  /**
   * Per-call consent for a network tool under the `local-only` policy
   * (asked before anything is sent). Default: the one-time web-research
   * consent the user gave in `research.ask` (`research/consent.ts`).
   * Outside `local-only` the policy already allows the network.
   */
  consentNetwork?: (request: NetworkConsentRequest) => boolean | Promise<boolean>;
  /**
   * Approval of a write or network tool call once the run has untrusted
   * content in its context (plan 2.7). Default: a confirm dialog naming the
   * tool, what it would do and where the untrusted content came from.
   * Under `local-only` a network call's own per-call consent (which then
   * carries the same warning) is that approval.
   */
  consentUntrusted?: (request: UntrustedConsentRequest) => boolean | Promise<boolean>;
  /**
   * The input is outside content (a clipped page, an imported note…): its
   * sources. The runtime also detects it from the path and frontmatter.
   */
  untrusted?: string[];
  /** Editor context for the editor tools. */
  document?: string;
  selection?: string;
  path?: string | null;
  /**
   * The open document the run works on (`agents/docKey.ts`). Default: the
   * active document's key when the run starts.
   */
  docKey?: string;
  /** Receives the pages `fetch_page` read in this run, by URL (the research command verifies quotes against them). */
  pages?: Map<string, FetchedPage>;
  /**
   * The input is meant to leave the device: the user asked for it to be
   * searched (research). The run then holds none of the user's own content
   * until a tool reads a note, and a web request after reading outside
   * content needs no approval before that (plan 2.7's rule guards the
   * user's data, and there is none in the run). Writes still ask.
   */
  inputMayLeave?: boolean;
  onDelta?: (chunk: string) => void;
  onStep?: (step: AgentStep) => void;
  /** Force an executor (the suggestions panel uses it). */
  executor?: ExecutorId;
  /** Apply a critic patch from the start (a retry the user asked for). */
  patch?: RetryPatch;
  /** One part of a split run (5.6.2): not announced as an answer of its own. */
  part?: boolean;
  /**
   * A non-palette request that pays for itself (see ChatOptions.ownPrompt):
   * counted against the monthly quota here, never billed to a waiting
   * palette command. `"silent"`: no toast when the quota is spent.
   */
  ownPrompt?: boolean | "silent";
  /** Already paid for (a batch job is charged once, when it is submitted): the run charges nothing. */
  prepaid?: boolean;
}
