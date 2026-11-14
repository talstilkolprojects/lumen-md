/**
 * Channels, sample rate and duration of an audio file from its own headers
 * (no ffprobe, no dependency): WAV (RIFF), FLAC (STREAMINFO) and Ogg (Opus,
 * Vorbis). Used to check the owner's ASR recordings against the bundle
 * contract, mono at 16 kHz or more and 5–20 s (eval/golden/README.md), before
 * they are hashed and scored (W1.32, Codex on #225).
 *
 * Returns { format, channels, sampleRate, seconds } or null when the bytes
 * are not a file of a known format (or are truncated / malformed).
 */

/** @param {Buffer} b */
function wav(b) {
  if (b.length < 12 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") return null;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let dataBytes = -1;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString("ascii", o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === "fmt " && o + 8 + 16 <= b.length) {
      channels = b.readUInt16LE(o + 10);
      sampleRate = b.readUInt32LE(o + 12);
      byteRate = b.readUInt32LE(o + 16);
    } else if (id === "data") {
      // A streamed WAV may declare 0 or 0xFFFFFFFF: count what is there.
      dataBytes = size === 0 || size === 0xffffffff ? b.length - (o + 8) : Math.min(size, b.length - (o + 8));
      break;
    }
    o += 8 + size + (size % 2);
  }
  if (!channels || !sampleRate || !byteRate || dataBytes < 0) return null;
  return { format: "wav", channels, sampleRate, seconds: dataBytes / byteRate };
}

/** @param {Buffer} b */
function flac(b) {
  // "fLaC", then the first metadata block: STREAMINFO (type 0), 34 bytes.
  if (b.length < 42 || b.toString("ascii", 0, 4) !== "fLaC" || (b[4] & 0x7f) !== 0) return null;
  const s = 8; // STREAMINFO body
  const sampleRate = (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4);
  const channels = ((b[s + 12] >> 1) & 0x07) + 1;
  const totalSamples = (b[s + 13] & 0x0f) * 2 ** 32 + b.readUInt32BE(s + 14);
  if (!sampleRate || !totalSamples) return null;
  return { format: "flac", channels, sampleRate, seconds: totalSamples / sampleRate };
}

/** The granule position of the last Ogg page of the stream that starts the file. */
function lastGranule(b, serial) {
  for (let o = b.length - 27; o >= 0; o--) {
    if (b[o] === 0x4f && b.toString("ascii", o, o + 4) === "OggS" && b.readUInt32LE(o + 14) === serial) {
      const g = b.readBigInt64LE(o + 6);
      if (g >= 0n) return Number(g);
    }
  }
  return null;
}

/** @param {Buffer} b */
function ogg(b) {
  if (b.length < 28 || b.toString("ascii", 0, 4) !== "OggS") return null;
  const serial = b.readUInt32LE(14);
  const segments = b[26];
  const body = 27 + segments;
  if (b.length < body + 19) return null;
  const head = b.subarray(body);
  const granule = lastGranule(b, serial);
  if (granule === null) return null;
  if (head.toString("ascii", 0, 8) === "OpusHead") {
    // Opus always decodes at 48 kHz; the header keeps the original input rate.
    const channels = head[9];
    const preSkip = head.readUInt16LE(10);
    const inputRate = head.readUInt32LE(12);
    return { format: "opus", channels, sampleRate: inputRate || 48000, seconds: Math.max(0, granule - preSkip) / 48000 };
  }
  if (head[0] === 1 && head.toString("ascii", 1, 7) === "vorbis") {
    const channels = head[11];
    const sampleRate = head.readUInt32LE(12);
    if (!sampleRate) return null;
    return { format: "vorbis", channels, sampleRate, seconds: granule / sampleRate };
  }
  return null;
}

/** @param {Buffer} bytes */
export function audioInfo(bytes) {
  try {
    return wav(bytes) ?? flac(bytes) ?? ogg(bytes);
  } catch {
    return null;
  }
}

/** The ASR bundle contract: null when it holds, else the rule it breaks (worded without any of the file's content). */
export function asrClipProblem(info, { minSeconds = 5, maxSeconds = 20, minRate = 16000 } = {}) {
  if (!info) return "every recording must be WAV, FLAC or Ogg Opus / Vorbis, and readable";
  if (info.channels !== 1) return "every recording must be mono";
  if (info.sampleRate < minRate) return `every recording must be sampled at ${minRate / 1000} kHz or more`;
  if (info.seconds < minSeconds || info.seconds > maxSeconds) return `every recording must last ${minSeconds}–${maxSeconds} s`;
  return null;
}
