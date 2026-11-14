/**
 * Credits (plan 6.1): the attribution every model and data file Lumen can
 * download asks for — CC BY in particular (the ivrit.ai speech model) —
 * read from models/registry.json, the same list the licence gate checks.
 * Lazy-loaded from the command palette.
 */
import { createRoot } from "react-dom/client";
import registry from "../../models/registry.json";
import { modelCredits, type LicenceFamily, type ModelCredit } from "../ai/modelCredits";
import { t } from "../i18n";
import "./creditsDialogStrings";
import { HelpButton } from "./HelpButton";

interface Entry {
  id: string;
  kind: string;
  source?: string;
  license: string;
  class: string;
  attribution?: string;
  delivery?: string;
}

/** Models the app can download or ships, with their attribution line. */
export function creditEntries(list: readonly Entry[] = (registry as { models: Entry[] }).models): Entry[] {
  return list.filter((m) => m.attribution && m.class !== "forbidden" && m.delivery !== "none").sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** What each licence asks of whoever ships the model. */
const REQUIREMENT: Record<LicenceFamily, string> = {
  "cc-by": "credits.req.ccBy",
  "cc-by-sa": "credits.req.ccBySa",
  apache: "credits.req.apache",
  mit: "credits.req.mit",
  mpl: "credits.req.mpl",
  llama: "credits.req.llama",
  gemma: "credits.req.gemma",
};

function CreditItem({ c }: { c: ModelCredit }) {
  return (
    <li data-testid="model-credit" data-model={c.id} style={{ marginBottom: 10 }}>
      <strong dir="ltr">{c.name}</strong> <span style={{ opacity: 0.7 }}>({c.kind})</span>
      <br />
      {t("credits.licence")}:{" "}
      {c.licenceUrl ? (
        <a href={c.licenceUrl} target="_blank" rel="noreferrer noopener" dir="ltr">
          {c.license}
        </a>
      ) : (
        <span dir="ltr">{c.license}</span>
      )}
      {c.source && (
        <>
          {" · "}
          {t("credits.source")}:{" "}
          <a href={c.source} target="_blank" rel="noreferrer noopener" dir="ltr">
            {c.source.replace(/^https:\/\//, "")}
          </a>
        </>
      )}
      <br />
      <span dir="auto" style={{ opacity: 0.85 }}>
        {c.attribution}
      </span>
      {c.family && (
        <>
          <br />
          <span style={{ opacity: 0.7, fontSize: 12 }}>{t(REQUIREMENT[c.family])}</span>
        </>
      )}
    </li>
  );
}

/** The model-credits section: Hebrew models (ivrit.ai, Dicta) first, then every other model. */
export function ModelCreditsSection({ credits }: { credits: ModelCredit[] }) {
  const hebrew = credits.filter((c) => c.hebrew);
  const other = credits.filter((c) => !c.hebrew);
  return (
    <section aria-labelledby="model-credits-title" data-testid="model-credits">
      <h3 id="model-credits-title">{t("credits.models")}</h3>
      {hebrew.length > 0 && (
        <>
          <h4>{t("credits.hebrew")}</h4>
          <ul style={{ paddingInlineStart: 18 }}>{hebrew.map((c) => <CreditItem key={c.id} c={c} />)}</ul>
        </>
      )}
      <h4>{t("credits.other")}</h4>
      <ul style={{ paddingInlineStart: 18 }}>{other.map((c) => <CreditItem key={c.id} c={c} />)}</ul>
    </section>
  );
}

export function openCredits(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  root.render(
    <div role="dialog" aria-modal="true" aria-label={t("credits.title")} onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === "Escape" && close()} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 12, padding: 20, maxWidth: 720, width: "100%", maxHeight: "80vh", overflow: "auto", fontSize: 13 }}>
        <h2 style={{ marginTop: 0 }}>{t("credits.title")}</h2>
        <HelpButton topic="ai/model-credits" />
        <p>{t("credits.intro")}</p>
        <ModelCreditsSection credits={modelCredits()} />
        <button type="button" autoFocus onClick={close} style={{ border: "1px solid hsl(var(--border-strong))", borderRadius: 6, padding: "4px 12px", background: "transparent", color: "inherit", cursor: "pointer" }}>
          {t("credits.close")}
        </button>
      </div>
    </div>,
  );
}
