#!/usr/bin/env node
/**
 * W6.10: is the Vercel project's Ignored Build Step set to our skip script?
 *
 * vercel.ts is compiled after the ignore step has run, so its ignoreCommand
 * is never read (scripts/vercel-ignore.sh): the rules apply only when the
 * project setting (Settings → Git → Ignored Build Step) is
 * `bash scripts/vercel-ignore.sh`. Until it is, every push to every branch
 * takes the one build slot. This reads the setting (GET only, nothing is
 * changed) and fails when it is missing or different.
 *
 *   VERCEL_TOKEN=… node scripts/check-vercel-ignore.mjs
 *
 * Env: VERCEL_TOKEN (read access is enough), VERCEL_PROJECT_ID and
 * VERCEL_TEAM_ID (default: this project and team). Exit 0 set, 1 not set or
 * different, 2 the setting could not be read (no token, API error): the
 * nightly report says which, so a missing token never passes as "set".
 *
 * The owner's one command to set it (plan W6.10):
 *   echo '{"commandForIgnoringBuildStep":"bash scripts/vercel-ignore.sh"}' > ignore.json
 *   vercel api "/v9/projects/prj_HBRHQedUcIu68Z2oJjScnI9Q6Spz?teamId=team_Wbm2NUwz3lSO2eEs1YkURQ7M" --method PATCH --input ignore.json
 * or the dashboard: Settings → Git → Ignored Build Step → Custom → that command.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_COMMAND = "bash scripts/vercel-ignore.sh";
export const PROJECT_ID = "prj_HBRHQedUcIu68Z2oJjScnI9Q6Spz";
export const TEAM_ID = "team_Wbm2NUwz3lSO2eEs1YkURQ7M";

/** The verdict on a project object from GET /v9/projects/{id}: { ok, line }. */
export function ignoreStepVerdict(project) {
  const cmd = typeof project?.commandForIgnoringBuildStep === "string" ? project.commandForIgnoringBuildStep.trim() : "";
  if (!cmd) return { ok: false, line: `Ignored Build Step is not set: every branch builds. Set it to \`${EXPECTED_COMMAND}\` (W6.10).` };
  if (cmd !== EXPECTED_COMMAND) return { ok: false, line: `Ignored Build Step is \`${cmd}\`, not \`${EXPECTED_COMMAND}\` (W6.10).` };
  return { ok: true, line: `Ignored Build Step is \`${EXPECTED_COMMAND}\`.` };
}

export async function readProject({ token, projectId = PROJECT_ID, teamId = TEAM_ID, fetchImpl = fetch }) {
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(teamId)}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET /v9/projects/${projectId}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    console.error("check-vercel-ignore: no VERCEL_TOKEN, so the setting could not be read (not a pass).");
    process.exit(2);
  }
  let project;
  try {
    project = await readProject({ token, projectId: process.env.VERCEL_PROJECT_ID || PROJECT_ID, teamId: process.env.VERCEL_TEAM_ID || TEAM_ID });
  } catch (e) {
    console.error(`check-vercel-ignore: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  const v = ignoreStepVerdict(project);
  (v.ok ? console.log : console.error)(`check-vercel-ignore: ${v.line}`);
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
