/**
 * The local route of "Train AI on my style" (plan 6.12.4), shown before the
 * cloud fine-tune: export a LoRA dataset from the notes (and the style
 * profile) and the script that trains it on this Mac or NVIDIA machine and
 * puts the result in Ollama. Nothing is uploaded. Lazy, with the dialog.
 */

import { useState } from "react";
import { t } from "../i18n";
import "../ai/localLoraStrings";

type Platform = "mac" | "nvidia";

export function LocalLoraSection() {
  const [folder, setFolder] = useState("");
  const [platform, setPlatform] = useState<Platform>(() => (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "mac" : "nvidia"));
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<null | { notes: number; trainSamples: number; validSamples: number; heldOut: number }>(null);
  const [error, setError] = useState<string | null>(null);

  const exportAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const [{ readAllNotes }, { proseOfNote, getStyleProfile }, lora, { zip }, { downloadBytes }] = await Promise.all([
        import("../storage/workspaceNotes"),
        import("../ai/styleProfiles"),
        import("../ai/localLora"),
        import("../storage/zip"),
        import("../storage/exportFormats"),
      ]);
      const prefix = folder.trim().replace(/^\/+|\/+$/g, "");
      const notes = (await readAllNotes()).filter((n) => !prefix || n.path.startsWith(prefix + "/"));
      const ds = lora.buildLoraDataset(notes, { prose: proseOfNote, profile: getStyleProfile() });
      if (ds.stats.trainSamples < 10 || ds.stats.heldOut < 1) {
        setError(t("lora.tooLittle", { notes: ds.stats.notes }));
        return;
      }
      const script = platform === "mac" ? "train-mac.sh" : "train-nvidia.sh";
      const bytes = await zip([
        { name: "lumen-lora/train.jsonl", data: ds.train },
        { name: "lumen-lora/valid.jsonl", data: ds.valid },
        { name: "lumen-lora/heldout.json", data: JSON.stringify(ds.heldOut) },
        { name: `lumen-lora/${script}`, data: platform === "mac" ? lora.macScript() : lora.nvidiaScript() },
      ]);
      downloadBytes("lumen-lora.zip", bytes, "application/zip");
      setStats(ds.stats);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const box = { padding: "12px 14px", borderRadius: 8, background: "hsl(var(--bg-subtle))", border: "1px solid hsl(var(--border))", display: "flex", flexDirection: "column", gap: 8 } as const;
  return (
    <section style={box} aria-labelledby="lora-local-title" data-testid="lora-local">
      <div id="lora-local-title" style={{ fontWeight: 600 }}>{t("lora.title")}</div>
      <div style={{ color: "hsl(var(--fg-muted))" }}>{t("lora.intro")}</div>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>{t("lora.folder")}</span>
        <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={t("lora.folderAll")} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit" }} />
      </label>
      <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", gap: 14 }}>
        <legend style={{ marginBottom: 4 }}>{t("lora.platform")}</legend>
        {(["mac", "nvidia"] as const).map((p) => (
          <label key={p} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="radio" name="lora-platform" checked={platform === p} onChange={() => setPlatform(p)} />
            {t(`lora.platform.${p}`)}
          </label>
        ))}
      </fieldset>
      <button type="button" onClick={() => void exportAll()} disabled={busy} data-testid="lora-export" style={{ alignSelf: "flex-start", padding: "6px 12px", borderRadius: 6, border: "none", background: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))", cursor: busy ? "wait" : "pointer" }}>
        {busy ? t("lora.exporting") : t("lora.export")}
      </button>
      {stats && (
        <div role="status" aria-live="polite" data-testid="lora-stats">
          {t("lora.exported", { notes: stats.notes, train: stats.trainSamples, valid: stats.validSamples, heldOut: stats.heldOut })}
        </div>
      )}
      {error && <div role="alert">{error}</div>}
      <div style={{ color: "hsl(var(--fg-muted))", fontSize: 12 }}>{t(`lora.next.${platform}`)}</div>
    </section>
  );
}
