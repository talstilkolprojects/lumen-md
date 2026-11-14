/** Plan 13.7: which screenshots to take (pure, tested). */

/** Every (device, locale, scene) to capture, numbered per device and locale. */
export function plan(cfg, { device, locale, theme = "light" } = {}) {
  const out = [];
  for (const [id, dev] of Object.entries(cfg.devices)) {
    if (device && id !== device) continue;
    for (const loc of ["he", "en"]) {
      if (locale && loc !== locale) continue;
      const seed = Object.fromEntries(Object.entries(cfg.seed).map(([name, t]) => [seedName(name, loc), t[loc]]));
      let n = 0;
      for (const sc of cfg.scenes) {
        if (sc.mobileOnly && !dev.mobile) continue;
        if (sc.desktopOnly && dev.mobile) continue;
        n++;
        out.push({
          device: id,
          locale: loc,
          theme,
          scene: sc.id,
          file: `${String(n).padStart(2, "0")}-${sc.id}.png`,
          title: sc.title[loc],
          open: sc.open ? seedName(sc.open, loc) : undefined,
          mode: dev.mobile && sc.phoneMode ? sc.phoneMode : (sc.mode ?? "split"),
          command: sc.command,
          keys: sc.keys,
          type: sc.type && loc === "en" ? "interview" : sc.type,
          url: sc.url,
          seed,
        });
      }
    }
  }
  return out;
}

/**
 * Seed file names: ASCII in both languages (the note's title inside is in
 * the screenshot's language). Chromium's OPFS refuses — or, headless on
 * Linux, crashes on — some non-ASCII names, which is why the app's vault
 * layer encodes paths; the seed writes OPFS directly, so it keeps to ASCII.
 */
export function seedName(name, locale) {
  const en = { "seminar.md": "research-seminar.md", "interview-1.md": "interview-1.md", "course.md": "algorithms-course.md" };
  const he = { "seminar.md": "seminar-mechkar.md", "interview-1.md": "reayon-1.md", "course.md": "kurs-algoritmim.md" };
  return (locale === "he" ? he : en)[name] ?? name;
}
