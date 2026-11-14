/**
 * The conditions 0.2.0-beta.1 ships encrypted sync under (plan W6.43, crypto
 * review 6): experimental and off by default in every channel, and no UI
 * that re-keys, revokes or enrolls a device until H1 (`rekeyBlocked` bound
 * to the epoch) is fixed. Pairing, which the review covered, stays.
 */
import { describe, it, expect, afterEach } from "vitest";
import { FLAGS, isEnabled, setFlag } from "../flags/flags";
import { buildSyncCommands, E2EE_FLAG } from "../commands/domains/file";

describe("encrypted sync in 0.2.0-beta.1 (W6.43)", () => {
  afterEach(() => setFlag(E2EE_FLAG, null));

  it("is experimental: off in beta and stable builds until the user turns it on", () => {
    expect(FLAGS.find((f) => f.id === E2EE_FLAG)?.stage).toBe("experimental");
    expect(isEnabled(E2EE_FLAG, { channel: "beta", overrides: {} })).toBe(false);
    expect(isEnabled(E2EE_FLAG, { channel: "stable", overrides: {} })).toBe(false);
  });

  it("with the flag off, its commands open Feature flags instead of the panels", () => {
    const opened: unknown[] = [];
    const on = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener("lumen-open-feature-flags", on);
    try {
      const cmds = buildSyncCommands();
      expect(cmds.map((c) => c.id)).toEqual(["sync.open", "sync.setup", "classroom.open"]);
      for (const c of cmds) c.action();
      expect(opened).toEqual([{ focus: E2EE_FLAG }, { focus: E2EE_FLAG }, { focus: E2EE_FLAG }]);
    } finally {
      window.removeEventListener("lumen-open-feature-flags", on);
    }
  });
});
