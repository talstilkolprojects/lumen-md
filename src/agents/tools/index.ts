/**
 * Every agent tool, by name. The 16 of plan §3 (T2) plus the helpers
 * agents use alongside them (`file_exists`, `get_headings`,
 * `extract_quotes`, `csv_parse`).
 *
 *   read     read_file, list_files, file_exists, search_workspace,
 *            get_frontmatter, list_tags, get_document, get_selection,
 *            get_headings, validate_mermaid, validate_echarts,
 *            validate_json, git_diff, extract_quotes, csv_parse,
 *            run_python — offline Pyodide sandbox (`./python.ts`)
 *   write    write_file, set_frontmatter, replace_range — stage a change
 *            for approval, never write (`../staging.ts`)
 *   network  search_web, fetch_page — AI policy + per-call consent +
 *            privacy ledger (`../network.ts`)
 */

import type { AgentTool } from "../types";
import { WORKSPACE_TOOLS } from "./workspace";
import { EDITOR_TOOLS } from "./editor";
import { VALIDATE_TOOLS } from "./validate";
import { GIT_TOOLS } from "./git";
import { WEB_TOOLS } from "./web";
import { DATA_TOOLS } from "./data";
import { PYTHON_TOOLS } from "./python";

export const ALL_TOOLS: readonly AgentTool[] = [...WORKSPACE_TOOLS, ...EDITOR_TOOLS, ...VALIDATE_TOOLS, ...GIT_TOOLS, ...WEB_TOOLS, ...DATA_TOOLS, ...PYTHON_TOOLS] as AgentTool[];

/** The tool list of plan §3 (T2), in its order. */
export const PLAN_TOOLS = [
  "read_file",
  "write_file",
  "list_files",
  "search_workspace",
  "get_frontmatter",
  "set_frontmatter",
  "list_tags",
  "get_document",
  "get_selection",
  "replace_range",
  "validate_mermaid",
  "validate_echarts",
  "validate_json",
  "git_diff",
  "search_web",
  "fetch_page",
] as const;

export function getTool(name: string): AgentTool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/** Tools by name, for agent definitions: `tools: pickTools("get_document", "list_tags")`. */
export function pickTools(...names: string[]): AgentTool[] {
  return names.map((n) => {
    const t = getTool(n);
    if (!t) throw new Error(`Unknown agent tool: ${n}`);
    return t;
  });
}
