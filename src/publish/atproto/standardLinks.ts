/** What a static site serves to prove it owns its Standard.site records (plan W7.19). Dependency-free: the site builder imports it. */

/** `/.well-known/site.standard.publication`: the publication's at:// URI, as Standard.site checks it. */
export function wellKnownPublication(publicationUri: string): string {
  return `${publicationUri}\n`;
}

/** The `<link>` a published page carries, so a reader can match the page and the record. */
export function documentLink(documentUri: string): string {
  return `<link rel="site.standard.document" href="${documentUri.replace(/"/g, "&quot;")}" />`;
}
