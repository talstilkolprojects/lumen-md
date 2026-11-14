/**
 * Helpers of the Bases interpreter (split out of evaluate.ts, plan W4.11):
 * argument coercion, Moment-style date formatting, relative times, tag and
 * folder matching.
 */
import { FormulaError } from "../formula/ast";
import { durationMs, isTagged, toText, type BasesFile, type BValue } from "./values";

/* ─── Helpers ────────────────────────────────────────────────────────── */

export const fileValue = (file: BasesFile): BValue => ({ $: "file", file });

export function textArg(v: BValue | undefined, what: string, at: number): string {
  if (v === undefined) throw new FormulaError("arity", `${what} needs an argument`, at);
  return toText(v);
}

export function numArg(v: BValue | undefined, what: string, at: number, fallback?: number): number {
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new FormulaError("arity", `${what} needs a number`, at);
  }
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "boolean" ? (v ? 1 : 0) : Number.NaN;
  if (!Number.isFinite(n)) throw new FormulaError("type", `${what} needs a number, not "${toText(v)}"`, at);
  return n;
}

export function toNumberOrNull(v: BValue): number | null {
  if (v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (isTagged(v) && v.$ === "duration") return durationMs(v);
  if (typeof v === "string") {
    const n = Number(v.trim());
    return v.trim() !== "" && Number.isFinite(n) ? n : null;
  }
  return null;
}

export function clean(n: number, at: number): number {
  if (!Number.isFinite(n)) throw new FormulaError("math", "the result is not a finite number", at);
  return Number.isInteger(n) ? n : Number(n.toPrecision(15));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
};

/** Moment.js-style tokens (what Obsidian's `format()` takes), in UTC. `[text]` is literal. */
export function formatMoment(d: Date, fmt: string): string {
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  const wd = d.getUTCDay();
  const h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  const ms = d.getUTCMilliseconds();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const tokens: Record<string, () => string> = {
    YYYY: () => pad(y, 4),
    YY: () => pad(y % 100),
    Q: () => String(Math.floor(mo / 3) + 1),
    MMMM: () => MONTHS[mo],
    MMM: () => MONTHS[mo].slice(0, 3),
    MM: () => pad(mo + 1),
    M: () => String(mo + 1),
    Do: () => ordinal(day),
    DD: () => pad(day),
    D: () => String(day),
    dddd: () => DAYS[wd],
    ddd: () => DAYS[wd].slice(0, 3),
    dd: () => DAYS[wd].slice(0, 2),
    d: () => String(wd),
    HH: () => pad(h),
    H: () => String(h),
    hh: () => pad(h12),
    h: () => String(h12),
    mm: () => pad(mi),
    m: () => String(mi),
    ss: () => pad(s),
    s: () => String(s),
    SSS: () => pad(ms, 3),
    A: () => (h < 12 ? "AM" : "PM"),
    a: () => (h < 12 ? "am" : "pm"),
    X: () => String(Math.floor(d.getTime() / 1000)),
    x: () => String(d.getTime()),
    Z: () => "+00:00",
  };
  const re = /\[([^\]]*)\]|YYYY|YY|Q|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a|X|x|Z/g;
  return fmt.replace(re, (tok, literal: string | undefined) => (literal !== undefined ? literal : tokens[tok]()));
}

export function relativeText(d: Date, now: Date, locale: string): string {
  const diff = d.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 86_400_000],
    ["month", 30 * 86_400_000],
    ["week", 7 * 86_400_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1000],
  ];
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (abs >= size || unit === "second") return fmt.format(Math.round(diff / size), unit);
  }
  return fmt.format(0, "second");
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const titleCase = (s: string) => s.replace(/(^|[\s\-_/])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());

/** Tag `a` matches `a` and `a/b` (nested tags), ignoring case and a leading `#`. */
export function tagMatches(tag: string, want: string): boolean {
  const t = tag.replace(/^#/, "").toLowerCase();
  const w = want.replace(/^#/, "").toLowerCase();
  return t === w || t.startsWith(`${w}/`);
}

export const normFolder = (f: string) => f.replace(/^\/+|\/+$/g, "").toLowerCase();
