/** The Argon2id Worker (W10.D13; excluded from tsconfig until 10.M): hash-wasm off the main thread. */
import { argon2idHere } from "./argon2";
import type { Argon2Input } from "../index";

self.onmessage = async (e: MessageEvent<Argon2Input>) => {
  try {
    const tag = await argon2idHere(e.data);
    (self as unknown as Worker).postMessage({ ok: true, tag }, [tag.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
  }
};
