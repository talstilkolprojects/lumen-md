/** Where webR is served (respects a non-root Vite base path): `<base>webr/`. */
export function webrBaseUrl(base: string = import.meta.env?.BASE_URL ?? "/"): string {
  return `${base.replace(/\/?$/, "/")}webr/`;
}
