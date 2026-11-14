/** Types of scripts/lib/gif.mjs (plan W4.34). */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}
export interface GifFrame extends RgbaImage {
  /** How long the frame shows, ms. */
  delayMs?: number;
}
export declare function decodePng(buf: Buffer | Uint8Array): RgbaImage;
export declare function buildPalette(frames: readonly RgbaImage[]): number[][];
export declare function lzw(indices: ArrayLike<number>, minCode?: number): Buffer;
export declare function encodeGif(frames: readonly GifFrame[], opts?: { loop?: number }): Buffer;
