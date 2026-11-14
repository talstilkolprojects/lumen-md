/**
 * Template placeholders (plan W3.6), filled in when a template becomes a note:
 *
 *   {{title}}       the new note's name
 *   {{date}}        today, YYYY-MM-DD (Obsidian's default format)
 *   {{time}}        now, HH:mm
 *   {{hebrewDate}}  today in the Hebrew calendar ("30 בחשוון 5787" in a
 *                   Hebrew UI, "30 Heshvan 5787" otherwise), from the
 *                   platform's Intl Hebrew calendar — no library
 *
 * The same names as Obsidian's core Templates plugin, so a template works the
 * same in both apps. Unknown placeholders are left as they are.
 */

const pad = (n: number) => String(n).padStart(2, "0");

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's date in the Hebrew calendar, or "" where Intl has no Hebrew calendar. */
export function hebrewDateOf(d: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "he" ? "he-IL-u-ca-hebrew" : "en-u-ca-hebrew", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return "";
  }
}

export interface TemplateVars {
  title: string;
  now?: Date;
  locale?: string;
}

export function expandTemplate(body: string, { title, now = new Date(), locale = "en" }: TemplateVars): string {
  const values: Record<string, () => string> = {
    title: () => title,
    date: () => isoDate(now),
    time: () => `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    hebrewDate: () => hebrewDateOf(now, locale),
  };
  return body.replace(/\{\{\s*(title|date|time|hebrewDate)\s*\}\}/g, (_, name: string) => values[name]());
}
