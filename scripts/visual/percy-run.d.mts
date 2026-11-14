export const PERCY_CLI: string;
export function percyCommand(argv?: string[], env?: Record<string, string | undefined>, now?: Date): { cmd: string; args: string[]; env: Record<string, string | undefined> };
