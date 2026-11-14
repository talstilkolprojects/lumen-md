/**
 * bounded() (src/lib/bounded.ts): a check that never settles ends at its
 * limit; one that settles in time passes its value or error through.
 */
import { describe, it, expect } from "vitest";
import { bounded, BoundedTimeoutError } from "../lib/bounded";

describe("bounded", () => {
  it("passes a value that arrives in time", async () => {
    await expect(bounded(Promise.resolve(42), 50)).resolves.toBe(42);
    await expect(bounded(async () => "late but in time", 50)).resolves.toBe("late but in time");
  });

  it("passes the work's own error through", async () => {
    await expect(bounded(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
    await expect(
      bounded(() => {
        throw new Error("sync boom");
      }, 50),
    ).rejects.toThrow("sync boom");
  });

  it("rejects with a BoundedTimeoutError naming the limit when the work never settles", async () => {
    const never = new Promise<number>(() => {});
    const err = await bounded(never, 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundedTimeoutError);
    expect((err as BoundedTimeoutError).ms).toBe(20);
    expect((err as Error).message).toBe("timed out after 20 ms");
  });
});
