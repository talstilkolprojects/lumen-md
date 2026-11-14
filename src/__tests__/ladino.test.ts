/** Plan W7.9: Ladino between the Aki Yerushalayim Latin spelling and Hebrew letters. */
import { describe, expect, it } from "vitest";
import { ladinoHebrewToLatin, ladinoLatinToHebrew, ladinoScript } from "../text/ladino";

describe("Ladino Latin ↔ Hebrew letters (W7.9)", () => {
  it("writes vowels as matres lectionis, an alef before an initial vowel, ה for a final a", () => {
    expect(ladinoLatinToHebrew("kaza")).toBe("קאזה");
    expect(ladinoLatinToHebrew("el ombre")).toBe("איל אומברי");
    expect(ladinoLatinToHebrew("djudio")).toBe("ג׳ודיו");
    expect(ladinoLatinToHebrew("mucho")).toBe("מוצ׳ו");
    expect(ladinoLatinToHebrew("mujer")).toBe("מוז׳יר");
    expect(ladinoLatinToHebrew("avlar")).toBe("אב׳לאר");
    expect(ladinoLatinToHebrew("Shalom")).toBe("שאלום");
    expect(ladinoLatinToHebrew("espanyol")).toBe("איספאניול");
    expect(ladinoLatinToHebrew("kayo")).toBe("קאייו");
  });

  it("reads Hebrew letters back, and counts the vowels it had to guess", () => {
    expect(ladinoHebrewToLatin("קאזה")).toEqual({ text: "kaza", guessed: 0 });
    // ו is o or u and י is e or i: "djudio" comes back as "djodio", with its three vowels marked as guessed.
    const r = ladinoHebrewToLatin("ג׳ודיו");
    expect(r.text).toBe("djodio");
    expect(r.guessed).toBe(3);
    expect(ladinoHebrewToLatin("אב׳לאר").text).toBe("avlar");
  });

  it("knows which script a text is in", () => {
    expect(ladinoScript("Aki Yerushalayim")).toBe("latin");
    expect(ladinoScript("אקי ירושלים")).toBe("hebrew");
  });
});
