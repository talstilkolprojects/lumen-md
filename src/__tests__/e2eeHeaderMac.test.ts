// The vault header's own checks (W4.17 survivors of src/sync/e2ee/header.ts): the protocol number
// it writes, a vault id that is not a string, and headerMacValid (fifth review F5) on a MAC that
// isn't base64url, under a key that can't verify, and after a field changed.
import { describe, it, expect } from "vitest";
import { utf8 } from "../sync/e2ee/bytes";
import { createHeader, decodeHeader, encodeHeader, headerMacValid, PROTOCOL_VERSION, UnsupportedProtocolError } from "../sync/e2ee/header";
import { TEST_ITERATIONS, TEST_POLICY } from "./helpers/e2ee";

describe("vault header checks", () => {
  it("writes protocol 1, the number every stored vault carries, and reads only that", async () => {
    expect(PROTOCOL_VERSION).toBe(1);
    const { header } = await createHeader("pw", { pbkdf2Iterations: TEST_ITERATIONS });
    expect(header.protocol).toBe(1);
    const raw = JSON.parse(new TextDecoder().decode(encodeHeader(header))) as Record<string, unknown>;
    expect(raw.protocol).toBe(1);
    expect(decodeHeader(utf8(JSON.stringify({ ...raw, protocol: 1 })), TEST_POLICY).protocol).toBe(1);
    expect(() => decodeHeader(utf8(JSON.stringify({ ...raw, protocol: 0 })), TEST_POLICY)).toThrow(UnsupportedProtocolError);
  });

  it("refuses a vault id that is not a string, or not 16 bytes, as a bad vault id", async () => {
    const { header } = await createHeader("pw", { pbkdf2Iterations: TEST_ITERATIONS });
    for (const vaultId of [123, null, ["AAAAAAAAAAAAAAAAAAAAAA"], "AAAA"]) {
      expect(() => decodeHeader(utf8(JSON.stringify({ ...header, vaultId })), TEST_POLICY), String(vaultId)).toThrow(/Bad vault id/);
    }
  });

  it("headerMacValid: true for its own key; false for a changed field, a MAC that isn't base64url, or a key that can't verify", async () => {
    const { header, keys } = await createHeader("pw", { pbkdf2Iterations: TEST_ITERATIONS });
    expect(await headerMacValid(header, keys.header)).toBe(true);
    expect(await headerMacValid({ ...header, kdf: { ...header.kdf, iterations: TEST_ITERATIONS + 1 } as typeof header.kdf }, keys.header)).toBe(false);
    expect(await headerMacValid({ ...header, mac: "a" }, keys.header)).toBe(false);
    const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    expect(await headerMacValid(header, aes)).toBe(false);
  });
});
