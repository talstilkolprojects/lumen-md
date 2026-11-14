/** Plan W7.9: the Yiddish list is downloaded only from its pinned commit, and only with the pinned SHA-256. */
import { describe, expect, it } from "vitest";
import { YIDDISH_DICT, yiddishDictUrl } from "../ai/yiddishSpell";
import { downloadYiddishDictionary, yiddishDictionaryInstalled } from "../ai/yiddishSpellService";

describe("Yiddish word list download (W7.9)", () => {
  it("downloads from the pinned commit and refuses a file whose SHA-256 differs", async () => {
    expect(yiddishDictUrl("dic")).toBe(`https://raw.githubusercontent.com/alephreish/hunspell-yi/${YIDDISH_DICT.commit}/yi.dic`);
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      return new Response("1\nאַ\n", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(downloadYiddishDictionary(fake)).rejects.toThrow(/SHA-256 differs/);
    expect(asked).toEqual([yiddishDictUrl("aff")]);
    expect(await yiddishDictionaryInstalled()).toBe(false);
  });

});
