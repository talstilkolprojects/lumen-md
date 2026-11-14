export interface ScreenshotCase {
  id: string;
  lang: "he" | "en";
  kind: "table" | "dialog" | "code" | "error";
  html: string;
  gold: string;
}
export function cases(): ScreenshotCase[];
export const FONTS: Record<"he" | "en", [string, string]>;
export function page(c: ScreenshotCase, fontUrl: string): string;
