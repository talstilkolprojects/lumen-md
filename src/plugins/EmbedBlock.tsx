import { t } from "../i18n";

interface Props {
  source: string;
}

interface Embed {
  src: string;
  /** Aspect ratio (height:width); defaults to 56.25 (16:9). */
  paddingPct: number;
  title: string;
  allow: string;
}

const ALLOW =
  "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen";

function parse(line: string): Embed | null {
  const url = line.trim();
  if (!url) return null;

  // YouTube (full URL, short URL, shorts)
  let m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([\w-]{11})/);
  if (m) {
    return {
      src: `https://www.youtube-nocookie.com/embed/${m[1]}`,
      paddingPct: 56.25,
      title: "YouTube",
      allow: ALLOW,
    };
  }
  // Vimeo
  m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) {
    return {
      src: `https://player.vimeo.com/video/${m[1]}`,
      paddingPct: 56.25,
      title: "Vimeo",
      allow: ALLOW,
    };
  }
  // Loom
  m = url.match(/loom\.com\/share\/([\w]+)/);
  if (m) {
    return {
      src: `https://www.loom.com/embed/${m[1]}`,
      paddingPct: 56.25,
      title: "Loom",
      allow: ALLOW,
    };
  }
  // CodePen
  m = url.match(/codepen\.io\/([^/]+)\/pen\/([\w]+)/);
  if (m) {
    return {
      src: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result&theme-id=dark`,
      paddingPct: 60,
      title: "CodePen",
      allow: ALLOW,
    };
  }
  // CodeSandbox
  m = url.match(/codesandbox\.io\/(?:s|p\/sandbox)\/([\w-]+)/);
  if (m) {
    return {
      src: `https://codesandbox.io/embed/${m[1]}?view=preview`,
      paddingPct: 65,
      title: "CodeSandbox",
      allow: ALLOW,
    };
  }
  // Figma
  if (/figma\.com\/(file|proto|design)\//.test(url)) {
    return {
      src: `https://www.figma.com/embed?embed_host=lumen&url=${encodeURIComponent(url)}`,
      paddingPct: 60,
      title: "Figma",
      allow: ALLOW,
    };
  }
  // Spotify
  m = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show)\/([\w]+)/);
  if (m) {
    return {
      src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`,
      paddingPct: 40,
      title: "Spotify",
      allow: "encrypted-media",
    };
  }
  // Google Maps — three forms: full /maps/place URL, /maps/embed?pb URL, or
  // a simple /maps?q query. We always normalise to the `?output=embed` form.
  if (/google\.[a-z.]+\/maps\/embed\?/.test(url)) {
    return { src: url, paddingPct: 60, title: "Google Maps", allow: ALLOW };
  }
  if (/google\.[a-z.]+\/maps/.test(url)) {
    // Try to extract @lat,lng,zoom
    const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)(?:,(\d+(?:\.\d+)?)z)?/);
    if (at) {
      const [lat, lng, zoom = "13"] = [at[1], at[2], at[3]];
      return {
        src: `https://www.google.com/maps?q=${lat},${lng}&z=${zoom}&output=embed`,
        paddingPct: 75,
        title: "Google Maps",
        allow: ALLOW,
      };
    }
    // Fallback: look for `?q=` and re-render with output=embed.
    const q = url.match(/[?&]q=([^&]+)/);
    if (q) {
      return {
        src: `https://www.google.com/maps?q=${q[1]}&output=embed`,
        paddingPct: 75,
        title: "Google Maps",
        allow: ALLOW,
      };
    }
    // Generic: append output=embed. May or may not work depending on Google's
    // server-side detection, but at least the iframe loads.
    const sep = url.includes("?") ? "&" : "?";
    return { src: `${url}${sep}output=embed`, paddingPct: 75, title: "Google Maps", allow: ALLOW };
  }
  // OpenStreetMap (alternative to Google Maps, no auth required)
  m = url.match(/openstreetmap\.org\/.*[?#]map=(\d+)\/(-?\d+\.\d+)\/(-?\d+\.\d+)/);
  if (m) {
    const [, zoom, lat, lng] = m;
    const span = 0.05 / Math.max(1, +zoom / 12);
    const bbox = `${+lng - span},${+lat - span},${+lng + span},${+lat + span}`;
    return {
      src: `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`,
      paddingPct: 75,
      title: "OpenStreetMap",
      allow: ALLOW,
    };
  }
  // Twitter / X — uses platform.twitter.com timeline embed
  m = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/);
  if (m) {
    return {
      src: `https://platform.twitter.com/embed/Tweet.html?id=${m[2]}&theme=dark`,
      paddingPct: 100,
      title: "X (Twitter)",
      allow: ALLOW,
    };
  }
  // Facebook posts and videos
  if (/facebook\.com\/.+\/(posts|videos)\//.test(url)) {
    const enc = encodeURIComponent(url);
    return {
      src: `https://www.facebook.com/plugins/post.php?href=${enc}&show_text=true&width=500`,
      paddingPct: 110,
      title: "Facebook",
      allow: ALLOW,
    };
  }
  // Instagram posts / reels
  m = url.match(/instagram\.com\/(?:p|reel|tv)\/([\w-]+)/);
  if (m) {
    return {
      src: `https://www.instagram.com/p/${m[1]}/embed/`,
      paddingPct: 130,
      title: "Instagram",
      allow: ALLOW,
    };
  }
  // TikTok
  m = url.match(/tiktok\.com\/@[\w.-]+\/video\/(\d+)/);
  if (m) {
    return {
      src: `https://www.tiktok.com/embed/v2/${m[1]}`,
      paddingPct: 160,
      title: "TikTok",
      allow: ALLOW,
    };
  }
  // Reddit posts
  m = url.match(/reddit\.com\/r\/([^/]+)\/comments\/([^/]+)/);
  if (m) {
    return {
      src: `https://www.redditmedia.com/r/${m[1]}/comments/${m[2]}/?embed=true&theme=dark`,
      paddingPct: 100,
      title: "Reddit",
      allow: ALLOW,
    };
  }
  // LinkedIn posts.
  //
  // Two URL forms reach us:
  //   1. The official embed URL — `linkedin.com/embed/feed/update/urn:li:share:…`
  //   2. The regular post URL the user copies from the address bar:
  //        `linkedin.com/posts/{user}_{slug}-activity-{ACTIVITY_ID}-…`
  //
  // For form 2 we lift the numeric activity id out of the slug and rebuild
  // the embed-share URL ourselves. LinkedIn renders both `urn:li:share:…`
  // and `urn:li:activity:…` shapes inside the same /embed/feed/update/ path.
  m = url.match(/linkedin\.com\/embed\/feed\/update\/(urn[\w:%-]+)/);
  if (m) {
    return {
      src: `https://www.linkedin.com/embed/feed/update/${m[1]}`,
      paddingPct: 110,
      title: "LinkedIn",
      allow: ALLOW,
    };
  }
  m = url.match(/linkedin\.com\/posts\/[\w%-]+-activity-(\d+)/i);
  if (m) {
    return {
      src: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${m[1]}`,
      paddingPct: 110,
      title: "LinkedIn",
      allow: ALLOW,
    };
  }
  // GitHub Gist (renders the gist HTML in an iframe via an HTML wrapper page).
  m = url.match(/gist\.github\.com\/([^/]+)\/([\w]+)/);
  if (m) {
    const html = `<html><body><script src="https://gist.github.com/${m[1]}/${m[2]}.js"></script></body></html>`;
    return {
      src: `data:text/html;base64,${btoa(html)}`,
      paddingPct: 80,
      title: "GitHub Gist",
      allow: ALLOW,
    };
  }
  // SoundCloud
  if (/soundcloud\.com\//.test(url)) {
    return {
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%237c5cff&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false`,
      paddingPct: 30,
      title: "SoundCloud",
      allow: "autoplay; encrypted-media",
    };
  }
  // Generic: just iframe the URL.
  if (/^https?:\/\//i.test(url)) {
    return {
      src: url,
      paddingPct: 60,
      title: "Embed",
      allow: ALLOW,
    };
  }
  return null;
}

export default function EmbedBlock({ source }: Props) {
  // Allow multi-line; render the first non-empty URL only.
  const url = source.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  const embed = parse(url);

  if (!embed) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(0 80% 60%)", fontSize: 13 }}>
          {t("block.embed.unrecognized")}
        </div>
      </div>
    );
  }

  return (
    <div className="chart-block">
      <div className="chart-block-header">
        <span>{embed.title}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "hsl(var(--accent))", fontSize: 11 }}
        >
          {t("block.embed.open")}
        </a>
      </div>
      <div
        style={{
          position: "relative",
          paddingBottom: `${embed.paddingPct}%`,
          height: 0,
          overflow: "hidden",
        }}
      >
        <iframe
          src={embed.src}
          title={embed.title}
          loading="lazy"
          allow={embed.allow}
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            border: 0,
          }}
        />
      </div>
    </div>
  );
}
