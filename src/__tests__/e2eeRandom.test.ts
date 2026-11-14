/**
 * Encrypted sync (plan 3.4) acceptance: 10,000 random sync rounds, 0 loss.
 *
 * Three devices share one simulated provider. Each step one device edits a
 * note (appending a unique token line), deletes a short note, syncs, or
 * several devices sync at the same time (their provider calls interleave).
 * About 3 % of provider calls fail — before the call, or after it took effect
 * with the answer lost — so rounds are cut off half way all the time.
 * Conflicts are settled by merging lines (most of the time) or keeping both.
 *
 * At the end, with faults off, every device converges to the same files and
 * every token ever written is still present, except tokens that a device
 * deliberately deleted while it could see them. Seeded, so a failure replays.
 */

import { describe, it, expect } from "vitest";
import { memoryProvider, ProviderUnavailableError } from "../sync/e2ee/provider";
import { asText, type ConflictResolver } from "../sync/e2ee/conflict";
import { RollbackError } from "../sync/e2ee/manifest";
import { utf8 } from "../sync/e2ee/bytes";
import { joinVault, mulberry32, newVault, snapshot, type Device } from "./helpers/e2ee";

const ROUNDS = 10_000;
const PATHS = ["a.md", "b.md", "notes/c.md", "notes/d.md", "e.md", "f.md", "שלום/ג.md", "x.bin"];

describe("e2ee sync: randomized rounds", () => {
  it(
    `${ROUNDS} random sync rounds with interruptions and races lose nothing`,
    async () => {
      const rnd = mulberry32(20261020);
      let faults = false;
      const provider = memoryProvider({
        yield: async () => {
          for (let i = Math.floor(rnd() * 3); i > 0; i--) await Promise.resolve();
        },
        fault: () => {
          if (faults && rnd() < 0.03) throw new ProviderUnavailableError();
        },
      });
      const merge: ConflictResolver = async (c) => {
        if (rnd() < 0.05) return { kind: "keepBoth" };
        const local = (asText(c.local) ?? "").split("\n");
        const seen = new Set(local);
        const remote = (asText(c.remote) ?? "").split("\n").filter((l) => !seen.has(l));
        return { kind: "content", data: utf8([...local, ...remote].join("\n")) };
      };
      const devices: Device[] = [await newVault(provider, merge)];
      devices.push(await joinVault("B", provider, merge), await joinVault("C", provider, merge));
      faults = true;

      const written: string[] = [];
      const removed = new Set<string>();
      let rounds = 0;
      let cut = 0;
      let conflicts = 0;
      let races = 0;
      const syncOne = async (d: Device) => {
        rounds++;
        try {
          const r = await d.sync.sync();
          conflicts += r.conflicts.length;
          races += r.retries;
        } catch (e) {
          if (e instanceof RollbackError) throw e; // an honest provider never triggers the guard
          if (!(e instanceof ProviderUnavailableError)) throw e;
          cut++;
        }
      };

      while (rounds < ROUNDS) {
        const d = devices[Math.floor(rnd() * devices.length)];
        const x = rnd();
        if (x < 0.4) {
          const p = PATHS[Math.floor(rnd() * PATHS.length)];
          const token = `t${written.length + 1}`;
          written.push(token);
          const cur = d.files.text(p);
          d.files.set(p, cur === undefined ? token : `${cur}\n${token}`);
        } else if (x < 0.41) {
          const all = [...d.files.files.keys()];
          const copies = all.filter((p) => p.includes("(conflict"));
          const short = (copies.length ? copies : all).filter((p) => (d.files.text(p) ?? "").split("\n").length <= 3);
          if (short.length) {
            const p = short[Math.floor(rnd() * short.length)];
            for (const l of (d.files.text(p) ?? "").split("\n")) removed.add(l);
            d.files.delete(p);
          }
        } else if (x < 0.8) {
          await syncOne(d);
        } else {
          await Promise.all(devices.filter(() => rnd() < 0.7).map(syncOne));
        }
      }

      faults = false;
      for (let i = 0; i < 4; i++) for (const d of devices) await d.sync.sync();

      // The run exercised what it claims to.
      expect(rounds).toBeGreaterThanOrEqual(ROUNDS);
      expect(cut).toBeGreaterThan(500);
      expect(conflicts).toBeGreaterThan(100);
      expect(races).toBeGreaterThan(50);
      expect(written.length).toBeGreaterThan(3000);

      // Convergence: every device has the same files.
      for (const d of devices.slice(1)) expect(snapshot(d)).toEqual(snapshot(devices[0]));
      // 0 loss.
      const present = new Set(snapshot(devices[0]).flatMap(([, t]) => t.split("\n")));
      const lost = written.filter((t) => !present.has(t) && !removed.has(t));
      expect(lost).toEqual([]);
      expect(removed.size).toBeLessThan(written.length / 10);
    },
    180_000,
  );
});
