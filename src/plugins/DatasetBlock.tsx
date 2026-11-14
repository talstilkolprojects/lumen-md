/**
 * A ```dataset block (plan W7.6): the table or chart of a local CSV
 * snapshot in the vault. It reads the file and never fetches: refreshing
 * is a palette command the user runs.
 */
import { useEffect, useState } from "react";
import CsvBlock from "./CsvBlock";
import { parseBlock } from "../sources/datagov/snapshot";
import { t } from "../i18n";
import "../sources/datagov/strings";

export default function DatasetBlock({ source }: { source: string }) {
  const block = parseBlock(source);
  const [csv, setCsv] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (!block) return;
    void import("../sources/datagov/app")
      .then((m) => m.readSnapshot(block))
      .then((text) => live && setCsv(text))
      .catch(() => live && setCsv(null));
    return () => {
      live = false;
    };
  }, [block?.snapshot]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!block) return <pre className="dataset-block-error">{t("datagov.badBlock")}</pre>;
  if (csv === undefined) return <div className="dataset-block-loading">{t("datagov.loading")}</div>;
  if (csv === null) return <div className="dataset-block-missing">{t("datagov.missing", { path: block.snapshot })}</div>;
  return (
    <figure className="dataset-block" aria-label={block.title}>
      <figcaption>{block.title}</figcaption>
      <CsvBlock source={csv} lang="csv" meta={block.view === "chart" ? "view=chart" : ""} />
    </figure>
  );
}
