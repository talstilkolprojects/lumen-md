import { Fragment, type ReactNode } from "react";
import { t } from "./index";

/**
 * t() for a sentence with markup inside it (plan 9.1):
 *
 *   tRich("block.database.kanbanNeeds", { field: <code>groupBy:</code> })
 *   // "Kanban needs a {field} column." → ["Kanban needs a ", <code>…</code>, " column."]
 *
 * Translators keep the whole sentence, with its {placeholders} where their
 * language puts them; the placeholders become React nodes (or text) here.
 * An unknown placeholder is left as written.
 */
export function tRich(id: string, vars: Record<string, ReactNode>): ReactNode {
  const parts = t(id).split(/(\{\w+\})/);
  return parts.map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    const value = m && m[1] in vars ? vars[m[1]] : part;
    return <Fragment key={i}>{value}</Fragment>;
  });
}
