/**
 * Argon2id over audited code (W10.D13, research R3.5; excluded from tsconfig
 * until 10.M, see ./audited.ts).
 *   hash-wasm      the PHC reference implementation compiled to WebAssembly,
 *                  run in a Worker when the page has one (./argon2Worker.ts),
 *                  so a 64 MiB × 3 derivation never blocks the editor.
 *   libsodium      crypto_pwhash (ALG_ARGON2ID13), the fallback. It derives
 *                  with parallelism 1 and no secret or associated data, so it
 *                  is used only for inputs of that shape (every vault the app
 *                  makes); anything else is refused, never derived differently.
 */
import type { Argon2Input } from "../index";

export class Argon2ParamsError extends Error {
  override name = "Argon2ParamsError";
}

/** hash-wasm's argon2id, in a Worker when there is one. */
export async function argon2idHashWasm(input: Argon2Input): Promise<Uint8Array> {
  if (typeof Worker === "function" && typeof window !== "undefined") {
    const worker = new Worker(new URL("./argon2Worker.ts", import.meta.url), { type: "module" });
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<{ ok: true; tag: Uint8Array } | { ok: false; error: string }>) => (e.data.ok ? resolve(e.data.tag) : reject(new Error(e.data.error)));
        worker.onerror = (e) => reject(new Error(e.message || "argon2 worker failed"));
        worker.postMessage(input);
      });
    } finally {
      worker.terminate();
    }
  }
  return argon2idHere(input);
}

/** hash-wasm on this thread (the Worker's body, and Node). */
export async function argon2idHere(input: Argon2Input): Promise<Uint8Array> {
  const { argon2id } = await import("hash-wasm");
  if (input.associatedData?.length) throw new Argon2ParamsError("hash-wasm's argon2id takes no associated data");
  return argon2id({
    password: input.password,
    salt: input.salt,
    secret: input.secret,
    parallelism: input.parallelism,
    iterations: input.iterations,
    memorySize: input.memoryKiB,
    hashLength: input.tagLength,
    outputType: "binary",
  });
}

/** libsodium's crypto_pwhash: Argon2id v1.3, parallelism 1, no secret, no associated data. */
export async function argon2idLibsodium(input: Argon2Input): Promise<Uint8Array> {
  if (input.parallelism !== 1 || input.secret?.length || input.associatedData?.length) {
    throw new Argon2ParamsError("libsodium's crypto_pwhash derives with parallelism 1 and no secret or associated data");
  }
  const sodium = (await import("libsodium-wrappers-sumo")).default;
  await sodium.ready;
  if (input.salt.length !== sodium.crypto_pwhash_SALTBYTES) throw new Argon2ParamsError(`libsodium needs a ${sodium.crypto_pwhash_SALTBYTES}-byte salt`);
  return sodium.crypto_pwhash(input.tagLength, input.password, input.salt, input.iterations, input.memoryKiB * 1024, sodium.crypto_pwhash_ALG_ARGON2ID13);
}
