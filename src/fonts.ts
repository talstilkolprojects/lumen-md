/**
 * Self-hosted fonts (T25). Each @fontsource stylesheet declares one weight
 * with per-script `unicode-range` subsets, so a page downloads only the
 * subsets it renders: Inter / Source Serif 4 / JetBrains Mono for Latin,
 * Heebo / Frank Ruhl Libre for Hebrew. Nothing is fetched from Google and
 * the files are precached by the service worker (woff2 glob in vite.config).
 */
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/500.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/heebo/400.css";
import "@fontsource/heebo/500.css";
import "@fontsource/heebo/600.css";
import "@fontsource/heebo/700.css";
import "@fontsource/frank-ruhl-libre/400.css";
import "@fontsource/frank-ruhl-libre/500.css";
import "@fontsource/frank-ruhl-libre/700.css";
