import { Component, createContext, lazy, Suspense, useContext, useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import type { JSX } from "react";
import { isAssetName, readWorkspaceBlob } from "../storage/workspace";
import { log } from "../lib/logger";
import { scheduleIdle } from "../lib/idle";
import { t } from "../i18n";
import {
  allowRemoteImageHosts,
  loadRemoteImagesOnce,
  remoteImageGate,
  remoteImagesUnavailable,
  remoteImagesVersion,
  subscribeRemoteImages,
  type RemoteImageGate,
} from "../lib/remoteImages";

const ChartBlock = lazy(() => import("../plugins/ChartBlock"));
const MermaidBlock = lazy(() => import("../plugins/MermaidBlock"));
const CsvBlock = lazy(() => import("../plugins/CsvBlock"));
const JsonTableBlock = lazy(() => import("../plugins/JsonTableBlock"));
const InsightsBlock = lazy(() => import("../plugins/InsightsBlock"));
const CodeDoctorBlock = lazy(() => import("../plugins/CodeDoctorBlock"));
const MapBlock = lazy(() => import("../plugins/MapBlock"));
const GraphvizBlock = lazy(() => import("../plugins/GraphvizBlock"));
const AbcBlock = lazy(() => import("../plugins/AbcBlock"));
const Model3DBlock = lazy(() => import("../plugins/Model3DBlock"));
const PlantUMLBlock = lazy(() => import("../plugins/PlantUMLBlock"));
const EmbedBlock = lazy(() => import("../plugins/EmbedBlock"));
const HtmlPreviewBlock = lazy(() => import("../plugins/HtmlPreviewBlock"));
const BibtexBlock = lazy(() => import("../plugins/BibtexBlock"));
const PluginBlockView = lazy(() => import("../plugins/runtime/PluginBlock"));
const TasksBlock = lazy(() => import("../plugins/TasksBlock"));
const DataBlock = lazy(() => import("../plugins/DataBlock"));
const DatabaseBlock = lazy(() => import("../views/DatabaseBlock"));
const LiveCssBlock = lazy(() => import("../plugins/LiveCssBlock"));
const LiveJsBlock = lazy(() => import("../plugins/LiveJsBlock"));
const LivePyBlock = lazy(() => import("../plugins/LivePyBlock"));
const LiveLuaBlock = lazy(() => import("../plugins/LiveLuaBlock"));
const LiveRBlock = lazy(() => import("../plugins/LiveRBlock"));
const LiveRubyBlock = lazy(() => import("../plugins/LiveRubyBlock"));
const PlaygroundBlock = lazy(() => import("../plugins/PlaygroundBlock"));
const LiveSqlBlock = lazy(() => import("../plugins/LiveSqlBlock"));
const LiveSvgBlock = lazy(() => import("../plugins/LiveSvgBlock"));
const LiveGlslBlock = lazy(() => import("../plugins/LiveGlslBlock"));

function getText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children))
    return children
      .map((c) => (typeof c === "string" ? c : ""))
      .join("");
  return "";
}

function PluginFallback({
  label,
  innerRef,
}: {
  label: string;
  innerRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={innerRef}
      data-lumen-block-pending={label}
      style={{
        margin: "1.25rem 0",
        padding: "1rem",
        border: "1px dashed hsl(var(--border-strong))",
        borderRadius: "0.5rem",
        background: "hsl(var(--bg-subtle))",
        color: "hsl(var(--fg-muted))",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, sans-serif",
        fontSize: "13px",
      }}
    >
      {t("block.loading", { label })}
    </div>
  );
}

/**
 * Per-block error boundary so a single broken Mermaid / Graphviz / EChart
 * spec doesn't crash the entire preview pipeline. The fallback renders a
 * compact error card with the message — the rest of the document keeps
 * rendering as if nothing happened.
 */
class BlockErrorBoundary extends Component<
  { label: string; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    // Log so the issue surfaces in dev tools / Sentry; don't toast — the
    // visible error card already conveys the problem to the reader.
    log.error(`[lumen-block:${this.props.label}]`, error);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          style={{
            margin: "12px 0",
            padding: "10px 14px",
            border: "1px solid hsl(0 80% 60% / 0.4)",
            borderRadius: 8,
            background: "hsl(0 80% 60% / 0.08)",
            color: "hsl(0 80% 70%)",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {t("block.renderFailed", { label: this.props.label, error: this.state.error.message })}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Gate a heavy block's lazy chunk behind visibility + idle time (A7 lever
 * 1/3). Inside the live preview, the block shows its placeholder until it
 * is within ~400px of the viewport AND the main thread is idle; only then
 * does React.lazy fetch mermaid / echarts / leaflet / … So the first paint
 * of a long doc like Welcome.md never competes with vendor downloads for
 * blocks the reader can't see yet.
 *
 * Outside a `[data-preview-root]` (print/export render targets, the AI
 * search answer, tests) there's no scroll viewport to wait on, so the
 * block hydrates immediately.
 */
function useDeferredHydration(): [React.RefObject<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    const el = ref.current;
    if (!el || !el.closest("[data-preview-root]") || typeof IntersectionObserver === "undefined") {
      setReady(true);
      return;
    }
    let cancelIdle: (() => void) | null = null;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        cancelIdle = scheduleIdle(() => setReady(true), 1000);
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelIdle?.();
    };
  }, [ready]);
  return [ref, ready];
}

/**
 * True while the tree is serialized with `renderToStaticMarkup` (HTML
 * export, `lumen publish`). That render never runs effects, so the
 * deferred-hydration gate would leave every block as "Loading…" forever,
 * and there's no runtime to hydrate it later — static rendering instead
 * keeps each block's source as a readable code block.
 */
export const StaticRenderContext = createContext(false);

/**
 * Static stand-in for an interactive block: its fenced source as a code
 * element (the surrounding markdown `<pre>` makes it a normal code block).
 */
function StaticBlock({ label, source, lang }: { label: string; source: string; lang?: unknown }) {
  return (
    <code
      className={`lumen-static-block${typeof lang === "string" && lang ? ` language-${lang}` : ""}`}
      data-lumen-block={label}
    >
      {source}
    </code>
  );
}

function withSuspense<P extends object>(
  Component: ComponentType<P>,
  label: string,
): ComponentType<P> {
  return function Wrapped(props: P) {
    const isStatic = useContext(StaticRenderContext);
    const [ref, ready] = useDeferredHydration();
    if (isStatic) {
      const p = props as { children?: React.ReactNode; source?: unknown; lang?: unknown };
      const source = typeof p.source === "string" ? p.source : getText(p.children);
      return <StaticBlock label={label} source={source} lang={p.lang} />;
    }
    if (!ready) {
      return <PluginFallback label={label} innerRef={ref} />;
    }
    return (
      <BlockErrorBoundary label={label}>
        <Suspense fallback={<PluginFallback label={label} />}>
          <Component {...props} />
        </Suspense>
      </BlockErrorBoundary>
    );
  };
}

interface BlockProps {
  children?: React.ReactNode;
  lang?: string;
  meta?: string;
}

const Chart = withSuspense<BlockProps>(
  (props) => <ChartBlock source={getText(props.children)} meta={props.meta} />,
  "chart",
);

const Mermaid = withSuspense<BlockProps>(
  (props) => <MermaidBlock source={getText(props.children)} />,
  "diagram",
);

const Csv = withSuspense<BlockProps>(
  (props) => (
    <CsvBlock
      source={getText(props.children)}
      lang={(props.lang as "csv" | "tsv") ?? "csv"}
      meta={props.meta}
    />
  ),
  "data",
);

const JsonTable = withSuspense<BlockProps>(
  (props) => <JsonTableBlock source={getText(props.children)} meta={props.meta} />,
  "data",
);

const Insights = withSuspense<BlockProps>(
  (props) => <InsightsBlock source={getText(props.children)} meta={props.meta} />,
  "insights",
);

const CodeDoctor = withSuspense<BlockProps>(
  (props) => <CodeDoctorBlock source={getText(props.children)} meta={props.meta} />,
  "code-doctor",
);

const MapView = withSuspense<BlockProps>(
  (props) => (
    <MapBlock
      source={getText(props.children)}
      lang={(props.lang as "map" | "geojson") ?? "map"}
    />
  ),
  "map",
);

const Graphviz = withSuspense<BlockProps>(
  (props) => <GraphvizBlock source={getText(props.children)} meta={props.meta} />,
  "diagram",
);

const Abc = withSuspense<BlockProps>(
  (props) => <AbcBlock source={getText(props.children)} />,
  "music",
);

const Model = withSuspense<BlockProps>(
  (props) => <Model3DBlock source={getText(props.children)} meta={props.meta} />,
  "3D model",
);

const PlantUML = withSuspense<BlockProps>(
  (props) => <PlantUMLBlock source={getText(props.children)} />,
  "diagram",
);

const Embed = withSuspense<BlockProps>(
  (props) => <EmbedBlock source={getText(props.children)} />,
  "embed",
);

const HtmlPreview = withSuspense<BlockProps>(
  (props) => (
    <HtmlPreviewBlock source={getText(props.children)} meta={props.meta} />
  ),
  "html preview",
);

/** A code block a plugin renders (plan 11.2): the plugin returns a UI tree, never HTML. */
const PluginBlockComp = withSuspense<BlockProps>(
  (props) => <PluginBlockView lang={props.lang ?? ""} source={getText(props.children)} />,
  "plugin",
);

const Bibtex = withSuspense<BlockProps>(
  (props) => <BibtexBlock source={getText(props.children)} />,
  "bibliography",
);

const Tasks = withSuspense<BlockProps>((props) => <TasksBlock source={getText(props.children)} />, "tasks");

// `lumen-data` covers the SQL / Pandas / JS-object / auto-detect family.
// The fence language flows through as `props.lang` so DataBlock can pick
// the right parser. All four use the same DataTable + chart-suggestion UI.
const DataBlockComp = withSuspense<BlockProps>(
  (props) => (
    <DataBlock
      source={getText(props.children)}
      meta={props.meta}
      lang={(props.lang as "sql" | "pandas" | "object" | "data") ?? "data"}
    />
  ),
  "data",
);

const Database = withSuspense<BlockProps>(
  (props) => (
    <DatabaseBlock source={getText(props.children)} meta={props.meta} />
  ),
  "database",
);

const LiveCss = withSuspense<BlockProps>(
  (props) => <LiveCssBlock source={getText(props.children)} meta={props.meta} />,
  "live-css",
);
const LiveJs = withSuspense<BlockProps>(
  (props) => <LiveJsBlock source={getText(props.children)} meta={props.meta} />,
  "live-js",
);
const LiveSvg = withSuspense<BlockProps>(
  (props) => <LiveSvgBlock source={getText(props.children)} meta={props.meta} />,
  "live-svg",
);
const LiveGlsl = withSuspense<BlockProps>(
  (props) => <LiveGlslBlock source={getText(props.children)} meta={props.meta} />,
  "live-glsl",
);
const LivePy = withSuspense<BlockProps>(
  (props) => <LivePyBlock source={getText(props.children)} meta={props.meta} />,
  "live-python",
);
const LiveLua = withSuspense<BlockProps>(
  (props) => <LiveLuaBlock source={getText(props.children)} meta={props.meta} />,
  "live-lua",
);
const LiveR = withSuspense<BlockProps>(
  (props) => <LiveRBlock source={getText(props.children)} meta={props.meta} />,
  "live-r",
);
const Playground = withSuspense<BlockProps>(
  (props) => <PlaygroundBlock source={getText(props.children)} meta={props.meta} />,
  "playground",
);
const LiveRuby = withSuspense<BlockProps>(
  (props) => <LiveRubyBlock source={getText(props.children)} meta={props.meta} />,
  "live-ruby",
);
const LiveSql = withSuspense<BlockProps>(
  (props) => <LiveSqlBlock source={getText(props.children)} meta={props.meta} />,
  "live-sql",
);

/**
 * Asset-aware <img> wrapper. If `src` looks like an OPFS asset (`lumen-asset-*`
 * or `./lumen-asset-*`), resolve it to a blob URL on first render. Cached blob
 * URLs survive across re-renders within the page lifetime (no revoke); OPFS
 * assets are tiny relative to a long-lived editor session, so this is a fair
 * trade. `![[image.png]]` embeds carry the file's version (mtime): an image
 * saved over at the same path is read again.
 */
const blobUrlCache = new Map<string, { url: string; version: string }>();

/** The cached URL for `key`, if it was made from this version of the file. */
function cachedBlobUrl(key: string, version: string): string | undefined {
  const c = blobUrlCache.get(key);
  return c && c.version === version ? c.url : undefined;
}

function isOpfsAssetSrc(src: string | undefined): src is string {
  if (!src) return false;
  if (/^[a-z]+:/i.test(src)) return false; // http:, data:, blob:, etc.
  const stripped = src.replace(/^\.\//, "").replace(/^\//, "");
  return isAssetName(stripped);
}

interface ImgProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src?: string;
  /** Workspace path of an `![[image.png]]` embed (./embeds) — read from OPFS. */
  "data-lumen-path"?: string;
  /** When that file last changed: a new version is read again, not served from the cache. */
  "data-lumen-version"?: string;
}

/** OPFS hands back files without a type; an SVG `<img>` needs one to render. */
function imageBlob(blob: Blob, path: string): Blob {
  return /\.svg$/i.test(path) && blob.type !== "image/svg+xml" ? new Blob([blob], { type: "image/svg+xml" }) : blob;
}

/**
 * An image from another site that the user has not allowed (plan 2.2): its
 * alt text, the host, and "Load" (this image, this session) / "Always allow"
 * (the host, in this browser). No request is made until one is clicked. In
 * the desktop app nothing can load (its CSP, plan 2.1), so no buttons.
 */
function RemoteImagePlaceholder({ alt, gate, media }: { alt?: string; gate: RemoteImageGate; media?: boolean }) {
  const host = gate.hosts.join(", ");
  const unavailable = remoteImagesUnavailable();
  return (
    <span
      className="lumen-remote-image"
      role="group"
      aria-label={t(media ? "remoteMedia.label" : "remoteImage.label", { host })}
      data-remote-image={host}
    >
      <span className="lumen-remote-image-text">
        <span className="lumen-remote-image-alt" dir="auto">{alt?.trim() || t("remoteImage.untitled")}</span>
        <span className="lumen-remote-image-host" dir="auto">
          {unavailable ? t("remoteImage.desktop", { host }) : t("remoteImage.blocked", { host })}
        </span>
      </span>
      {!unavailable && (
        <>
          <button type="button" title={t("remoteImage.loadHint", { host })} onClick={() => loadRemoteImagesOnce(gate.urls)}>
            {t("remoteImage.load")}
          </button>
          <button type="button" title={t("remoteImage.allowHint", { host })} onClick={() => allowRemoteImageHosts(gate.hosts)}>
            {t("remoteImage.allowHost", { host })}
          </button>
        </>
      )}
    </span>
  );
}

type MediaProps = React.VideoHTMLAttributes<HTMLVideoElement>;

/**
 * <video> / <audio> from another site wait for the user like images (plan
 * 2.2): WebKit fetches a media src even with preload="none". The sanitizer
 * leaves other-site media at most one URL, its own src.
 */
function gatedMedia(Tag: "video" | "audio") {
  return function LumenMedia(props: MediaProps) {
    const isStatic = useContext(StaticRenderContext);
    useSyncExternalStore(subscribeRemoteImages, remoteImagesVersion, remoteImagesVersion);
    const gate = remoteImageGate(props.src);
    if (!isStatic && gate.blocked) {
      const name = (props.src ?? "").split(/[?#]/)[0].split("/").pop() || undefined;
      return <RemoteImagePlaceholder alt={props.title || name} gate={gate} media />;
    }
    return <Tag {...(props as React.HTMLAttributes<HTMLElement>)} />;
  };
}
const LumenVideo = gatedMedia("video");
const LumenAudio = gatedMedia("audio");

function LumenImg(props: ImgProps) {
  const { src, srcSet, ...rest } = props;
  // Exports (static markup) keep the real image: the file is for others.
  const isStatic = useContext(StaticRenderContext);
  useSyncExternalStore(subscribeRemoteImages, remoteImagesVersion, remoteImagesVersion);
  const gate = remoteImageGate(src, srcSet);
  // The workspace file to show: an embed's path, or a pasted asset's name.
  // Never the raw path as `src` — the browser would ask the server for it.
  const wsPath = props["data-lumen-path"];
  const key = wsPath ? normalize(wsPath) : isOpfsAssetSrc(src) ? normalize(src) : null;
  const version = props["data-lumen-version"] ?? "";
  // The blob URL of a workspace file, tagged with the file (and version) it
  // belongs to: a retained element whose src changed must never render the
  // old value — not even for the one render before the effect runs (it may be
  // another site's image the gate has since stopped judging). Other srcs
  // render straight from the prop.
  const tag = `${key ?? ""}|${version}`;
  const [resolved, setResolved] = useState<{ for: string; url: string | undefined }>(() => ({
    for: tag,
    url: key ? cachedBlobUrl(key, version) : undefined,
  }));
  useEffect(() => {
    if (!key) return;
    const cached = cachedBlobUrl(key, version);
    if (cached) {
      setResolved({ for: tag, url: cached });
      return;
    }
    let cancelled = false;
    readWorkspaceBlob(key)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(imageBlob(blob, key));
        blobUrlCache.set(key, { url, version });
        setResolved({ for: tag, url });
      })
      .catch(() => {
        if (!cancelled) setResolved({ for: tag, url: undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [key, version, tag]);
  const shown = !key ? src : resolved.for === tag ? resolved.url : cachedBlobUrl(key, version);
  // The author-supplied `alt` is forwarded via {...rest}. We default to
  // the basename of the src when nothing is provided so screen-readers
  // get something descriptive instead of "image".
  const fallbackAlt = !rest.alt
    ? (src ?? "").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "image"
    : undefined;
  if (isStatic) return <img alt={fallbackAlt} loading="lazy" {...rest} srcSet={srcSet} src={shown} />;
  if (!key && gate.blocked) return <RemoteImagePlaceholder alt={rest.alt} gate={gate} />;
  return <img alt={fallbackAlt} loading="lazy" {...rest} srcSet={key ? undefined : gate.srcSet} src={shown} />;
}

/**
 * `![[file.pdf]]` (./embeds): a card that opens the workspace PDF in a new
 * tab. The app's CSP has no frame / object source for workspace files, and
 * an in-page viewer (PDF.js) would be a heavy dependency for this.
 */
function LumenEmbedFile(props: { path?: string; name?: string; kind?: string; children?: React.ReactNode }) {
  const isStatic = useContext(StaticRenderContext);
  const path = props.path ?? "";
  const name = props.name || path.split("/").pop() || path;
  const open = () => {
    readWorkspaceBlob(path)
      .then((blob) => {
        // Typed as a PDF whatever the file holds, so it can only open in
        // the browser's PDF viewer.
        const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
        window.open(url, "_blank", "noopener");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch((e: unknown) => log.warn("[embed] could not open", path, e));
  };
  return (
    <span className="lumen-embed-file" data-embed-path={path}>
      <span className="lumen-embed-file-badge" aria-hidden="true">PDF</span>
      <span className="lumen-embed-file-name" dir="auto">{name}</span>
      {!isStatic && path && (
        <button type="button" className="lumen-embed-file-open" onClick={open}>
          {t("embed.openPdf")}
        </button>
      )}
    </span>
  );
}

function normalize(src: string): string {
  return src.replace(/^\.\//, "").replace(/^\//, "");
}

/**
 * GFM task-list checkbox override — adds aria-label so screen readers can
 * announce the task text instead of an unlabeled "checkbox".
 */
function LumenInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  if (props.type === "checkbox") {
    // The fast first-paint pipeline and the full pipeline don't agree on
    // whether an unchecked task carries `checked={false}` or no `checked` at
    // all; React then sees the same input flip controlled → uncontrolled
    // when the full render swaps in. Always pass a boolean so it stays
    // controlled (read-only unless a handler is supplied).
    return (
      <input
        {...props}
        checked={Boolean(props.checked)}
        readOnly={props.onChange ? props.readOnly : true}
        aria-label={props["aria-label"] ?? t("block.task.label")}
      />
    );
  }
  return <input {...props} />;
}

/**
 * Click-to-copy support for Shiki code blocks.
 * Mounted once at the document root by the Preview component.
 */
export function CopyButtonHandler() {
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest("[data-copy]") as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      const text = btn.getAttribute("data-copy") ?? "";
      navigator.clipboard?.writeText(text).then(() => {
        const original = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = original;
        }, 1100);
      });
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}

// rehype-react expects a record of lowercase tag names → React components.
// Custom tag names use kebab-case so they pass through unchanged.
// Each plugin component reads only the props it needs; the cast widens its
// signature to the shared block-props shape so the registry types check.
type LumenBlock = ComponentType<JSX.IntrinsicAttributes & BlockProps>;

export const components: Record<string, LumenBlock> = {
  "lumen-chart": Chart as unknown as LumenBlock,
  "lumen-mermaid": Mermaid as unknown as LumenBlock,
  "lumen-csv": Csv as unknown as LumenBlock,
  "lumen-tsv": Csv as unknown as LumenBlock,
  "lumen-jsontable": JsonTable as unknown as LumenBlock,
  "lumen-insights": Insights as unknown as LumenBlock,
  "lumen-code-doctor": CodeDoctor as unknown as LumenBlock,
  "lumen-map": MapView as unknown as LumenBlock,
  "lumen-geojson": MapView as unknown as LumenBlock,
  "lumen-dot": Graphviz as unknown as LumenBlock,
  "lumen-abc": Abc as unknown as LumenBlock,
  "lumen-model": Model as unknown as LumenBlock,
  "lumen-plantuml": PlantUML as unknown as LumenBlock,
  "lumen-embed": Embed as unknown as LumenBlock,
  "lumen-htmlpreview": HtmlPreview as unknown as LumenBlock,
  "lumen-bibtex": Bibtex as unknown as LumenBlock,
  "lumen-pluginblock": PluginBlockComp as unknown as LumenBlock,
  "lumen-tasks": Tasks as unknown as LumenBlock,
  "lumen-data": DataBlockComp as unknown as LumenBlock,
  "lumen-database": Database as unknown as LumenBlock,
  "lumen-livecss": LiveCss as unknown as LumenBlock,
  "lumen-livejs": LiveJs as unknown as LumenBlock,
  "lumen-livesvg": LiveSvg as unknown as LumenBlock,
  "lumen-liveglsl": LiveGlsl as unknown as LumenBlock,
  "lumen-livepython": LivePy as unknown as LumenBlock,
  "lumen-livesql": LiveSql as unknown as LumenBlock,
  "lumen-livelua": LiveLua as unknown as LumenBlock,
  "lumen-liver": LiveR as unknown as LumenBlock,
  "lumen-liveruby": LiveRuby as unknown as LumenBlock,
  "lumen-playground": Playground as unknown as LumenBlock,
  // Asset-resolving <img> override.
  img: LumenImg as unknown as LumenBlock,
  video: LumenVideo as unknown as LumenBlock,
  audio: LumenAudio as unknown as LumenBlock,
  // `![[file.pdf]]` card.
  "lumen-embed-file": LumenEmbedFile as unknown as LumenBlock,
  // GFM task-list checkboxes get an aria-label so they aren't announced bare.
  input: LumenInput as unknown as LumenBlock,
};
