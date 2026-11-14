/**
 * Plan W4.17 — the privacy ledger's train-4 additions, as behaviour: the
 * Knesset and government-data routes (W7.5, W7.6) are cloud text under
 * their own reason on every host they use, a stylesheet and a LAN link are
 * recorded as sending nothing, and the ledger keeps the last 200 entries
 * half a second after the last change (no sooner).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetLedger, classify, ledgerEntries, recordLanSync, recordStyleRequest } from "../ai/privacyLedger";

const PERSIST_KEY = "lumen.privacy.ledger";

afterEach(() => {
  vi.useRealTimers();
  __resetLedger();
  try {
    localStorage.removeItem(PERSIST_KEY);
  } catch {
    /* no storage */
  }
});

describe("privacy ledger: what train 4 added", () => {
  it("keeps the last 200 entries, 500 ms after the last change and not before", () => {
    vi.useFakeTimers();
    __resetLedger();
    localStorage.removeItem(PERSIST_KEY);
    for (let i = 0; i < 205; i++) recordLanSync(`10.0.0.${i % 250}`);
    vi.advanceTimersByTime(499);
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull();
    vi.advanceTimersByTime(1);
    const saved = JSON.parse(localStorage.getItem(PERSIST_KEY) ?? "[]") as Array<{ id: number }>;
    expect(saved.length).toBe(200);
    expect(saved[0].id).toBe(6);
    expect(saved[199].id).toBe(205);
  });

  it.each([
    ["https://knesset.gov.il/OdataV4/ParliamentInfo/KNS_Law", "Knesset"],
    ["https://main.knesset.gov.il/Activity/Legislation", "Knesset"],
    ["https://data.gov.il/api/3/action/package_search?q=x", "Government data"],
    ["https://apis.cbs.gov.il/series/data/list?id=1", "Government data"],
  ])("%s is cloud text with its own reason", (url, reason) => {
    const hit = classify(url);
    expect(hit?.category).toBe("cloud-text");
    expect(hit?.reason).toContain(reason);
  });

  it("a host next to those is not taken for them", () => {
    expect(classify("https://www.knesset.gov.il.example.com/")?.reason ?? "").not.toContain("Knesset");
    expect(classify("https://cbs.gov.il/")?.reason ?? "").not.toContain("Government data");
  });

  it("a stylesheet request is recorded as sending nothing, under its own host", () => {
    recordLanSync("192.168.1.2");
    const e = recordStyleRequest("https://fonts.example.org/theme.css");
    expect(e.host).toBe("fonts.example.org");
    expect(e.bytesOut).toBe(0);
    expect(e.bytesIn).toBeNull();
    expect(e.category).toBe("third-party");
  });

  it("a LAN link starts with nothing sent and nothing received", () => {
    const id = recordLanSync("192.168.1.9");
    const e = ledgerEntries().find((x) => x.id === id)!;
    expect(e.bytesOut).toBe(0);
    expect(e.bytesIn).toBe(0);
    expect(e.method).toBe("LAN");
    expect(e.category).toBe("local-ai");
  });
});
