/**
 * Put `vars` into a message template: `{key}` (canonical) and `{{key}}`
 * (some early templates used double braces — a real production bug, users
 * saw literal "{5} / {100}"). The double-brace form goes first so the
 * single-brace pass doesn't leave inner braces behind. A key without a
 * value stays as written. Dependency-free, so the render worker
 * (src/renderer/render.worker.ts) fills its notices exactly as `t` does.
 */
export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`))
    .replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}
