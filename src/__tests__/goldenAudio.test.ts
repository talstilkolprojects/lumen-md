// @vitest-environment node
/**
 * scripts/golden/audioInfo.mjs: channels, sample rate and duration from the
 * file's own header, so the owner's ASR recordings are checked against the
 * bundle contract (mono, >= 16 kHz, 5-20 s) before they are hashed (W1.32, #225).
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import { asrClipProblem, audioInfo } from "../../scripts/golden/audioInfo.mjs";

/** A PCM WAV of silence. */
function wavBytes(channels: number, rate: number, seconds: number): Buffer {
  const data = Math.round(rate * seconds) * channels * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(data, 40);
  return b;
}

/** A FLAC header (fLaC + STREAMINFO) for the given stream. */
function flacBytes(channels: number, rate: number, samples: number): Buffer {
  const b = Buffer.alloc(42);
  b.write("fLaC", 0, "ascii");
  b[4] = 0x80; // last block, type 0 (STREAMINFO)
  b.writeUIntBE(34, 5, 3);
  const s = 8;
  b[s + 10] = (rate >> 12) & 0xff;
  b[s + 11] = (rate >> 4) & 0xff;
  b[s + 12] = ((rate & 0x0f) << 4) | ((channels - 1) << 1) | 0; // bps-1 high bit 0
  b[s + 13] = (15 << 4) | Math.floor(samples / 2 ** 32); // bps-1 = 15 (16-bit)
  b.writeUInt32BE(samples % 2 ** 32, s + 14);
  return b;
}

/** An Ogg Opus file: the OpusHead page and a last page with the given granule. */
function opusBytes(channels: number, inputRate: number, granule: number, preSkip = 312): Buffer {
  const page = (payload: Buffer, g: number) => {
    const h = Buffer.alloc(27 + 1);
    h.write("OggS", 0, "ascii");
    h.writeBigInt64LE(BigInt(g), 6);
    h.writeUInt32LE(7, 14); // serial
    h[26] = 1;
    h[27] = payload.length;
    return Buffer.concat([h, payload]);
  };
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head[8] = 1;
  head[9] = channels;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(inputRate, 12);
  return Buffer.concat([page(head, 0), page(Buffer.from("x"), granule)]);
}

describe("audioInfo", () => {
  it("reads WAV, FLAC and Ogg Opus headers", () => {
    expect(audioInfo(wavBytes(1, 16000, 6))).toMatchObject({ format: "wav", channels: 1, sampleRate: 16000, seconds: 6 });
    expect(audioInfo(flacBytes(2, 44100, 44100 * 12))).toMatchObject({ format: "flac", channels: 2, sampleRate: 44100, seconds: 12 });
    const opus = audioInfo(opusBytes(1, 48000, 48000 * 8 + 312));
    expect(opus).toMatchObject({ format: "opus", channels: 1, sampleRate: 48000 });
    expect(opus.seconds).toBeCloseTo(8, 5);
  });
  it("is null for bytes of no known format, or a truncated header", () => {
    expect(audioInfo(Buffer.from("ID3 not supported"))).toBeNull();
    expect(audioInfo(wavBytes(1, 16000, 1).subarray(0, 30))).toBeNull();
    expect(audioInfo(Buffer.alloc(0))).toBeNull();
  });
});

describe("asrClipProblem: the bundle contract", () => {
  it("accepts mono, >= 16 kHz, 5-20 s", () => {
    expect(asrClipProblem(audioInfo(wavBytes(1, 16000, 5)))).toBeNull();
    expect(asrClipProblem(audioInfo(flacBytes(1, 48000, 48000 * 20)))).toBeNull();
  });
  it("names the broken rule, never the file", () => {
    expect(asrClipProblem(audioInfo(wavBytes(2, 16000, 6)))).toBe("every recording must be mono");
    expect(asrClipProblem(audioInfo(wavBytes(1, 8000, 6)))).toBe("every recording must be sampled at 16 kHz or more");
    expect(asrClipProblem(audioInfo(wavBytes(1, 16000, 4)))).toBe("every recording must last 5–20 s");
    expect(asrClipProblem(audioInfo(flacBytes(1, 16000, 16000 * 21)))).toBe("every recording must last 5–20 s");
    expect(asrClipProblem(null)).toMatch(/WAV, FLAC or Ogg Opus/);
  });
});
