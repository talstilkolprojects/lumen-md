/**
 * The names the vault-encryption layer (plan 11.4) keeps for itself. Kept
 * apart from the crypto code so the vault layer can recognise an encrypted
 * vault at start-up without loading it.
 */
export const HEADER_PATH = ".lumen-encryption.json";
export const HEADER_BACKUP_PATH = ".lumen-encryption.backup.json";
/** Suffix of a conversion's temporary copy (`note.md.lumen-convert`). */
export const TEMP_SUFFIX = ".lumen-convert";

/** The layer's own files, which no caller sees or may write. */
export function isLayerPath(path: string): boolean {
  const p = path.split("/").filter(Boolean).join("/");
  return p === HEADER_PATH || p === HEADER_BACKUP_PATH || p.endsWith(TEMP_SUFFIX);
}

/** The first bytes of an encrypted file (`\0LME` + format 1). */
export const ENCRYPTED_PREFIX = [0x00, 0x4c, 0x4d, 0x45, 0x01] as const;
export const ENCRYPTED_TEXT_PREFIX = String.fromCharCode(...ENCRYPTED_PREFIX);
