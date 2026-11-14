/**
 * Known WebGPU gaps by browser (plan 5.7), for the AI settings. Its own
 * module so the panel loads it lazily: the model manager is in the
 * startup bundle (the executors import it), this is not.
 */

import type { Hardware } from "./modelManager";

/**
 * Why there is no WebGPU on this browser, when it is a known gap rather
 * than a broken driver: Firefox ships WebGPU on Windows and macOS but not
 * yet on Linux or Android, and Android browsers in general vary (plan 5.7).
 * The in-browser model is then off; speech and search models run on WASM,
 * and agents go to Ollama. null = WebGPU works, or the gap is unknown.
 */
export function webGpuGap(hw: Pick<Hardware, "webgpu">, ua: string = typeof navigator !== "undefined" ? navigator.userAgent ?? "" : ""): "firefox-linux" | "android" | null {
  if (hw.webgpu) return null;
  if (/Android/i.test(ua)) return "android";
  if (/Firefox\//i.test(ua) && /Linux/i.test(ua)) return "firefox-linux";
  return null;
}
