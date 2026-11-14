/**
 * Which vault files the text indexes read (review #272, step 2.17).
 *
 * The search index (BM25 / workspace index) and the embeddings read every
 * file they index as text. An imported PDF, an image or any other binary
 * decoded as text is megabytes of gibberish: a memory spike in the search
 * worker, junk hits, and binary content sent to an embeddings provider. So
 * the indexes take an allowlist of note and plain-text extensions, and skip
 * everything else.
 */

/** Notes and plain-text markup the editor opens as text. */
const TEXT_NOTE_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdx|txt|text|rst|adoc|asciidoc|org|tex)$/i;

/** Is `path` a note / plain-text file the text indexes may read? */
export function isIndexableTextPath(path: string): boolean {
  return TEXT_NOTE_EXT.test(path);
}
