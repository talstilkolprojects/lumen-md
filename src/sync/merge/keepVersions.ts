/**
 * Both versions of an automatically merged note go into its history (plan
 * W1.9), so a merge can always be undone from the version list.
 */
export async function keepBothVersions(path: string, ours: string, theirs: string): Promise<void> {
  const { recordSnapshot } = await import("../../storage/history");
  await recordSnapshot(path, theirs, "merge").catch(() => false);
  await recordSnapshot(path, ours, "merge").catch(() => false);
}
