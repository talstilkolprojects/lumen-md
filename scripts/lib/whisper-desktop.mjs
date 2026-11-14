/**
 * Desktop Whisper (plan W1.17): the pure parts of scripts/whisper-desktop.mjs,
 * pinned by src/__tests__/whisperDesktopScripts.test.ts.
 */

/** HH:MM:SS,mmm → ms (null when malformed). Same rule as whisper_core.rs. */
export function srtTime(s) {
  const m = /^(\d+):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/.exec(String(s).trim());
  if (!m) return null;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, "0");
}

/** SRT → [{ startMs, endMs, text }] (whisper-cli -osrt). */
export function parseSrt(srt) {
  const out = [];
  for (const cue of String(srt).replace(/\r\n/g, "\n").split("\n\n")) {
    const lines = cue.split("\n").map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const startMs = srtTime(a);
    const endMs = srtTime(b);
    const text = lines.slice(at + 1).join(" ").trim();
    if (startMs === null || endMs === null || !text) continue;
    out.push({ startMs, endMs: Math.max(endMs, startMs), text });
  }
  return out;
}

/** Problems with the values to pin into WHISPER_GGML (empty = ok). */
export function validatePin({ repo, revision, file, bytes, sha256 }) {
  const p = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) p.push("--repo must be <owner>/<name>");
  if (!/^[0-9a-f]{40}$/.test(revision ?? "")) p.push("--revision must be a 40-character commit sha (not a branch)");
  if (!/^[A-Za-z0-9][\w.-]*\.bin$/.test(file ?? "")) p.push("--file must be a plain *.bin file name");
  if (!(Number.isInteger(bytes) && bytes > 0)) p.push("--bytes must be the file size in bytes");
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) p.push("--sha256 must be 64 lowercase hex characters");
  return p;
}

/** The WHISPER_GGML block for src/ai/dictation/whisperDesktop.ts. */
export function pinSnippet({ repo, revision, file, bytes, sha256 }) {
  return [
    "export const WHISPER_GGML: GgmlModel = {",
    '  sourceRepo: "ivrit-ai/whisper-large-v3-turbo",',
    '  license: "Apache-2.0",',
    `  repo: "${repo}",`,
    `  revision: "${revision}",`,
    `  file: "${file}",`,
    `  bytes: ${bytes},`,
    `  sha256: "${sha256}",`,
    "};",
  ].join("\n");
}

/**
 * Speed: real-time factor (compute / audio) and what an hour of audio
 * would take at that rate. Target (plan W1.17): < 10 minutes per hour.
 */
export function speedReport(computeMs, audioMs) {
  const rtf = audioMs > 0 ? computeMs / audioMs : null;
  const minutesPerHour = rtf === null ? null : Math.round(rtf * 60 * 10) / 10;
  return { rtf: rtf === null ? null : Math.round(rtf * 1000) / 1000, minutesPerHour, underTarget: minutesPerHour !== null && minutesPerHour < 10 };
}
