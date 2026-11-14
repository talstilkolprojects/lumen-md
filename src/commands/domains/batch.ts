/** AI batch jobs over a folder of notes. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t } from "../../i18n";
import { uiConfirm, uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";

/** Submit a batch job over a folder of notes; check jobs and apply their results. */
export function buildBatchCommands(): Command[] {
  return [
    {
      id: "ai.batch",
      label: t("cmd.ai.batch"),
      hint: t("cmd.ai.batch.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const batch = await import("../../ai/batch");
        const { getActiveProvider, effectiveModel } = await import("../../ai/llm");
        const provider = batch.batchProviderFor(getActiveProvider());
        if (!provider) {
          showAiToast(t("batch.provider"), "error");
          return;
        }
        const op = await uiSelect({
          title: t("cmd.ai.batch"),
          message: t("batch.op"),
          defaultValue: "tags",
          choices: [
            { value: "tags", label: t("batch.op.tags") },
            { value: "summary", label: t("batch.op.summary") },
            { value: "translate", label: t("batch.op.translate") },
          ],
        });
        if (op !== "tags" && op !== "summary" && op !== "translate") return;
        let lang: string | undefined;
        if (op === "translate") {
          lang = (await uiPrompt({ message: t("batch.lang"), defaultValue: "English" }))?.trim();
          if (!lang) return;
        }
        const folder = await uiPrompt({ message: t("batch.folder"), defaultValue: "" });
        if (folder === null) return;
        const prefix = folder.trim().replace(/^\/+|\/+$/g, "");
        const { readAllNotes } = await import("../../storage/workspaceNotes");
        const all = await readAllNotes();
        // Skip translations earlier batches created (by their
        // `translatedFrom` marker, or the older recorded paths — not by
        // file-name shape) so a re-run doesn't translate them.
        const made = batch.knownTranslations();
        const notes = all.filter(
          (n) => (!prefix || n.path.startsWith(prefix + "/")) && !(op === "translate" && (made.has(n.path) || batch.isBatchTranslation(n.text))),
        );
        if (!notes.length) {
          showAiToast(t("batch.noNotes"), "error");
          return;
        }
        const { aiQuotaStatus, recordAiPrompt } = await import("../../billing/aiQuota");
        const quota = aiQuotaStatus();
        if (Number.isFinite(quota.limit) && quota.remaining < notes.length) {
          showAiToast(t("batch.quota", { count: notes.length }), "error");
          return;
        }
        const { estimateTokens, costOf } = await import("../../ai/usage");
        // A local job runs on Ollama or the in-browser model only; show the model that will actually answer.
        let model: string;
        if (provider === "local") {
          const route = await batch.localBatchRoute();
          if (!route) {
            showAiToast(new batch.NoLocalModelError().message, "error");
            return;
          }
          model = route.model;
        } else model = effectiveModel(provider);
        let input = 0;
        let output = 0;
        for (const n of notes) {
          const r = batch.requestFor(op, n.text, lang);
          input += estimateTokens(r.system + r.user);
          // A translation is about as long as the (possibly truncated) text sent.
          output += op === "translate" ? Math.min(r.maxTokens, estimateTokens(r.user)) : r.maxTokens / 2;
        }
        const usd = provider === "local" ? 0 : costOf({ provider, model, inputTokens: input, outputTokens: output, batch: true });
        const ok = await uiConfirm({
          message:
            provider === "local"
              ? t("batch.confirmLocal", { count: notes.length, model })
              : t("batch.confirm", { count: notes.length, provider, model, cost: usd === null ? "?" : `~$${usd.toFixed(2)}` }),
        });
        if (!ok) return;
        try {
          const job = await batch.submitBatch(op, notes, { lang });
          if (Number.isFinite(quota.limit)) for (let i = 0; i < notes.length; i++) recordAiPrompt();
          showAiToast(t("batch.submitted", { count: job.items.length }), "success");
        } catch (e) {
          showAiToast((e as Error).message, "error");
        }
      },
    },
    {
      id: "ai.batchCheck",
      label: t("cmd.ai.batchCheck"),
      hint: t("cmd.ai.batchCheck.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const batch = await import("../../ai/batch");
        const jobs = batch.loadJobs();
        const pending = jobs.filter((j) => j.status === "submitted" || j.status === "ended");
        if (!pending.length) {
          showAiToast(t("batch.none"), "info");
          return;
        }
        const { writeWorkspaceFile } = await import("../../storage/workspace");
        let processing = 0;
        let wroteAny = false;
        for (const job of pending) {
          let results;
          try {
            results = await batch.fetchBatchResults(job);
          } catch (e) {
            showAiToast((e as Error).message, "error");
            continue;
          }
          if (results.state === "processing") {
            processing++;
            continue;
          }
          if (results.state !== "ended") {
            // Tell the user before the job leaves the pending list.
            job.status = results.state;
            showAiToast(t("batch.terminal", { op: job.op, id: job.id, state: t(`batch.state.${results.state}`) }), "error");
            continue;
          }
          job.status = "ended";
          // Record the metering now: if the state can't be saved, stop
          // before writing anything (a later check would meter again).
          if (!batch.saveJobs(jobs)) {
            showAiToast(t("batch.saveFailed", { id: job.id }), "error");
            return;
          }
          const { readAllNotes } = await import("../../storage/workspaceNotes");
          const notes = await readAllNotes();
          const open = new Set(useAppStore.getState().openTabs.map((tab) => tab.workspaceName).filter(Boolean));
          const current = useAppStore.getState().doc.workspaceName;
          if (current) open.add(current);
          const changed: string[] = [];
          const writes = batch
            .planWrites(
              job,
              results.answers,
              (p) => notes.find((n) => n.path === p)?.text ?? null,
              (p) => notes.some((n) => n.path.toLowerCase() === p.toLowerCase()),
              changed,
            )
            // A note open in a tab may have unsaved edits: skip it (and
            // translations made from it).
            .filter((w) => !open.has(w.path) && !open.has(w.source));
          const created = writes.filter((w) => w.created).length;
          const notes2 = [results.failed ? `${results.failed} failed` : "", changed.length ? `${changed.length} edited since — skipped` : ""].filter(Boolean).join(", ");
          const ok = await uiConfirm({
            message: t("batch.apply", { op: job.op, changes: writes.length - created, created, failed: notes2 ? ` (${notes2})` : "" }),
          });
          if (!ok) continue;
          // Write one by one; a failure keeps what was written and leaves
          // the job retryable without duplicating finished translations.
          const done: string[] = [];
          let failedWrites = 0;
          for (const w of writes) {
            try {
              await writeWorkspaceFile(w.path, w.content);
              done.push(w.path);
              job.done = [...(job.done ?? []), w.source];
            } catch {
              failedWrites++;
            }
          }
          if (done.length) wroteAny = true;
          job.status = failedWrites ? "ended" : "applied";
          // A retry after a failed save is safe (translations carry their
          // job's marker; tags merge; summaries replace), but say so.
          if (!batch.saveJobs(jobs)) {
            showAiToast(t("batch.saveFailed", { id: job.id }), "error");
            if (wroteAny) window.dispatchEvent(new CustomEvent("lumen-workspace-changed"));
            return;
          }
          // Saved as applied: a local job's stored answers are no longer needed.
          if (job.status === "applied" && job.provider === "local") void batch.clearLocalBatch(job.id);
          showAiToast(t("batch.applied", { count: done.length }), failedWrites ? "error" : "success");
        }
        if (!batch.saveJobs(jobs)) showAiToast(t("batch.saveFailed", { id: pending.map((j) => j.id).join(", ") }), "error");
        // File tree, tags, backlinks and database views refresh on this.
        if (wroteAny) window.dispatchEvent(new CustomEvent("lumen-workspace-changed"));
        if (processing) showAiToast(t("batch.processing", { count: processing }), "info");
      },
    },
  ];
}
