/**
 * The eval vault as module mocks (plan 5.3): `storage/workspace` over
 * EVAL_VAULT in memory, `sync/git` with EVAL_GIT. For vi.mock factories:
 *
 *   vi.mock("../storage/workspace", async (orig) => (await import("./helpers/evalVault")).workspaceModule(await orig()));
 */
import { EVAL_GIT, EVAL_VAULT } from "../../agents/eval/fixtures";

export const vaultFiles = new Map<string, string>(Object.entries(EVAL_VAULT));

export function resetVault(): void {
  vaultFiles.clear();
  for (const [p, c] of Object.entries(EVAL_VAULT)) vaultFiles.set(p, c);
}

export function workspaceModule(orig: object): object {
  return {
    ...orig,
    isOPFSAvailable: () => true,
    listWorkspace: async () => [...vaultFiles.keys()].map((path) => ({ path, name: path.split("/").pop()!, size: vaultFiles.get(path)!.length, modified: path.startsWith("journal/") ? 2000 : 1000 })),
    readWorkspaceFile: async (p: string) => {
      if (!vaultFiles.has(p)) throw new Error("ENOENT");
      return vaultFiles.get(p)!;
    },
    writeWorkspaceFile: async (p: string, c: string) => void vaultFiles.set(p, c),
    workspaceHasFile: async (p: string) => vaultFiles.has(p),
    deleteWorkspaceFile: async (p: string) => void vaultFiles.delete(p),
    isAssetName: () => false,
  };
}

export function gitModule(orig: object): object {
  return { ...orig, listGitRepos: async () => [EVAL_GIT.repo], gitDiffEntries: async () => EVAL_GIT.changes };
}
