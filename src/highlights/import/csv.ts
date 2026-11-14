/**
 * RFC 4180 CSV (plan W2.15, for Readwise's export): quoted fields may hold
 * commas, newlines and doubled quotes; a BOM is dropped; CRLF or LF.
 */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f !== ""));
}

/** Rows as objects by the header row's names. */
export function csvRecords(text: string): Array<Record<string, string>> {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  const names = head.map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? ""])));
}
