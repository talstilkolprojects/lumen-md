/**
 * Plan W6.2 (weakness E2): the live site's metadata names only our host.
 *
 * Checks the three files a search engine or a link preview reads first:
 * index.html (canonical, og:url, og:image, twitter:image, JSON-LD), robots.txt
 * (Sitemap:) and sitemap.xml (<loc>). Every one of those URLs must be on
 * OUR_HOST, and the domain the project never names must appear nowhere in
 * them. That domain is built from parts here, like the PR gate's
 * (scripts/lib/prGate.mjs), so it is never written in the repository.
 *
 * Pure functions; scripts/live-meta.mjs fetches the files.
 */

export const OUR_HOST = "lumen-md.vercel.app";
export const PAGES = ["index.html", "robots.txt", "sitemap.xml"];

/** The domain the project never names (the owner's rule), as a pattern. */
export const FOREIGN = new RegExp(`${["lumen", "md"].join("\\.")}\\b`, "i");
/** A copy of it, for the self-test only: never written to a file. */
export const foreignHost = () => ["lumen", "md"].join(".");

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"))?.slice(2).find((v) => v !== undefined) ?? null;

/** The metadata URLs of an HTML page → [{ where, url }]. */
export function htmlMetaUrls(html) {
  const out = [];
  const text = String(html ?? "");
  for (const [tag] of text.matchAll(/<link\b[^>]*>/gi)) if (/^canonical$/i.test(attr(tag, "rel") ?? "")) out.push({ where: "canonical", url: attr(tag, "href") });
  for (const [tag] of text.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    if (["og:url", "og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:url"].includes(key)) out.push({ where: key, url: attr(tag, "content") });
  }
  for (const m of text.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      out.push({ where: "JSON-LD", url: null, error: "JSON-LD is not valid JSON" });
      continue;
    }
    const walk = (v, path) => {
      if (typeof v === "string") {
        if (/^https?:\/\//i.test(v) && !/^https?:\/\/schema\.org\b/i.test(v)) out.push({ where: `JSON-LD ${path}`, url: v });
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    };
    walk(data, "");
  }
  return out;
}

export const robotsSitemaps = (text) => [...String(text ?? "").matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => ({ where: "Sitemap", url: m[1] }));
export const sitemapLocs = (xml) => [...String(xml ?? "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => ({ where: "<loc>", url: m[1] }));

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * pages: { "index.html": { status, text }, "robots.txt": …, "sitemap.xml": … }
 * → { ok, problems: string[], checked: [{ page, where, url }] }
 */
export function checkLiveMeta(pages, host = OUR_HOST) {
  const problems = [];
  const checked = [];
  for (const name of PAGES) {
    const p = pages[name];
    if (!p) {
      problems.push(`${name}: not fetched`);
      continue;
    }
    if (p.status !== undefined && p.status !== 200) problems.push(`${name}: HTTP ${p.status}`);
    String(p.text ?? "")
      .split("\n")
      .forEach((line, i) => {
        if (FOREIGN.test(line)) problems.push(`${name}:${i + 1}: names the domain that is not ours`);
      });
  }
  const html = pages["index.html"]?.text ?? "";
  const meta = htmlMetaUrls(html);
  for (const need of ["canonical", "og:url", "og:image", "twitter:image"]) if (!meta.some((m) => m.where === need)) problems.push(`index.html: no ${need}`);
  if (!meta.some((m) => m.where.startsWith("JSON-LD") && m.url)) problems.push("index.html: no URL in JSON-LD");
  const all = [...meta.map((m) => ({ page: "index.html", ...m })), ...robotsSitemaps(pages["robots.txt"]?.text).map((m) => ({ page: "robots.txt", ...m })), ...sitemapLocs(pages["sitemap.xml"]?.text).map((m) => ({ page: "sitemap.xml", ...m }))];
  if (pages["robots.txt"] && !all.some((m) => m.page === "robots.txt")) problems.push("robots.txt: no Sitemap line");
  if (pages["sitemap.xml"] && !all.some((m) => m.page === "sitemap.xml")) problems.push("sitemap.xml: no <loc>");
  for (const m of all) {
    if (m.error) {
      problems.push(`${m.page}: ${m.error}`);
      continue;
    }
    const h = hostOf(m.url);
    checked.push({ page: m.page, where: m.where, url: m.url });
    if (h !== host) problems.push(`${m.page} ${m.where}: points at ${h ?? "an invalid URL"}, not ${host}`);
  }
  return { ok: problems.length === 0, problems, checked };
}

/** Pages that pass: what the live site must look like (the self-test plants into these). */
export function goodPages(host = OUR_HOST) {
  const u = `https://${host}`;
  return {
    "index.html": {
      status: 200,
      text: `<!doctype html><html><head>\n<meta property="og:url" content="${u}/" />\n<meta property="og:image" content="${u}/icon-512.png" />\n<meta name="twitter:image" content="${u}/icon-512.png" />\n<link rel="canonical" href="${u}/" />\n<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","url":"${u}/"}</script>\n</head><body></body></html>\n`,
    },
    "robots.txt": { status: 200, text: `User-agent: *\nAllow: /\n\nSitemap: ${u}/sitemap.xml\n` },
    "sitemap.xml": { status: 200, text: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${u}/</loc></url></urlset>\n` },
  };
}

/**
 * The check must fail when a foreign reference is planted. Each plant is a
 * copy of `pages` (default: goodPages, which must pass first) with one
 * change. Returns what went wrong: [] when every plant was caught.
 */
export function selfTest(pages = goodPages(), host = OUR_HOST) {
  const base = checkLiveMeta(pages, host);
  if (!base.ok) return [`the unplanted pages already fail (${base.problems[0]}): plant into pages that pass`];
  const f = foreignHost();
  const html = pages["index.html"]?.text ?? "";
  const swap = (name, text) => ({ ...pages, [name]: { ...pages[name], text } });
  const plants = [
    ["canonical to the foreign domain", swap("index.html", html.replace(/(<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["'])[^"']*/i, `$1https://${f}/`))],
    ["og:image to the foreign domain", swap("index.html", html.replace(/<\/head>/i, `<meta property="og:image" content="https://${f}/x.png" /></head>`))],
    ["og:url to another host", swap("index.html", html.replace(/(<meta\b[^>]*property\s*=\s*["']og:url["'][^>]*content\s*=\s*["'])[^"']*/i, "$1https://evil.example.com/"))],
    ["the foreign domain in body text", swap("index.html", html.replace(/<\/body>/i, `<p>${f}</p></body>`))],
    ["robots.txt Sitemap to the foreign domain", swap("robots.txt", `${pages["robots.txt"]?.text ?? ""}\nSitemap: https://${f}/sitemap.xml\n`)],
    ["sitemap.xml <loc> to another host", swap("sitemap.xml", String(pages["sitemap.xml"]?.text ?? "").replace(/<\/urlset>/i, "<url><loc>https://evil.example.com/</loc></url></urlset>"))],
  ];
  return plants.filter(([, p]) => checkLiveMeta(p, host).ok).map(([name]) => `missed: ${name}`);
}
