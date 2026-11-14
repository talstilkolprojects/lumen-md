/**
 * The render worker's request handler (plan 8.1), apart from the worker
 * global so tests run the exact code the worker runs.
 *
 * Requests are handled one at a time, in order: the pipeline's host (the
 * request's strings and plugin languages, its theme) is set for the
 * request being rendered, and a long note never interleaves with another.
 * A request made stale by a newer one on its channel is skipped while it is
 * queued and its result dropped when it finishes late.
 */
import type { Root as HastRoot } from "hast";
import { blockSlugs, buildBlockProcessor, SLUG_TEXTS_KEY, withoutPositions, HOST_DATA_KEY, renderHast, renderHastFast, type HastProcessor, type RenderHost } from "./renderCore";
import { defaultCalloutTitle, isKnownCallout } from "./remarkObsidian";
import { fillTemplate } from "../i18n/fill";
import { prepareCriticMarkup } from "./criticMarkup";
import { asRawText, boundMarkdown } from "./boundMarkdown";
import { DARK_DATA_KEY, type HostData, type RenderBlockRequest, type RenderDocRequest, type RenderHoverRequest, type RenderReply, type RenderRequest } from "./renderProtocol";
import { previewMarkdown } from "./hoverMarkdown";
import type { EmbedContext } from "./embeds";

export interface RenderHandler {
  /** Handle one message; resolves to the reply to post, or null for none (a cancel). */
  handle(msg: RenderRequest): Promise<RenderReply | null>;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function createRenderHandler(): RenderHandler {
  /** Per channel: requests below this version are stale. */
  const latest = new Map<string, number>();
  let current: { dark: boolean; host: HostData; langs: Set<string> } = { dark: false, host: { strings: {}, pluginLangs: [] }, langs: new Set() };
  const isDark = () => current.dark;
  // The request's host, passed with each file (not set globally: in tests the window's pipeline shares this module).
  const requestHost: RenderHost = {
    calloutTitle: (kind, type) => (isKnownCallout(type) ? (current.host.strings[`callout.${kind}`] ?? defaultCalloutTitle(kind, type)) : defaultCalloutTitle(kind, type)),
    pluginLang: (lang) => current.langs.has(lang),
  };
  // The block processor per document variant.
  const blockProcessors = new Map<string, Promise<HastProcessor>>();

  const stale = (r: { channel: string | null; version: number }) => r.channel !== null && r.version < (latest.get(r.channel) ?? -Infinity);
  const see = (r: { channel: string | null; version: number }) => {
    if (r.channel !== null && r.version > (latest.get(r.channel) ?? -Infinity)) latest.set(r.channel, r.version);
  };

  async function renderDoc(r: RenderDocRequest): Promise<{ hast: HastRoot; used?: string[] }> {
    let embeds: EmbedContext | undefined;
    if (r.embeds) {
      const { createEmbedContext } = await import("./embeds");
      const strings = r.host.strings;
      embeds = createEmbedContext({
        hostPath: r.embeds.hostPath,
        hostText: r.embeds.hostText,
        files: r.embeds.files,
        notice: (kind, vars) => fillTemplate(strings[`embed.${kind}`] ?? kind, vars),
      });
    }
    const hast = await renderHast(r.markdown, isDark, embeds, r.variant, requestHost);
    return { hast, used: embeds ? [...embeds.used] : undefined };
  }

  async function renderBlock(r: RenderBlockRequest): Promise<{ hast: HastRoot; slugTexts: string[] }> {
    const variant = `${r.raw ? 1 : 0}${r.math ? 1 : 0}`;
    let proc = blockProcessors.get(variant);
    if (!proc) {
      proc = buildBlockProcessor(isDark, { raw: r.raw, math: r.math }, blockSlugs);
      blockProcessors.set(variant, proc);
      proc.catch(() => blockProcessors.delete(variant));
    }
    const p = await proc;
    const file = await p.process({ value: prepareCriticMarkup(r.asRaw ? asRawText(r.text) : boundMarkdown(r.text)), data: { [HOST_DATA_KEY]: requestHost, [DARK_DATA_KEY]: r.dark } });
    return { hast: withoutPositions(file.result as HastRoot), slugTexts: (file.data[SLUG_TEXTS_KEY] as string[] | undefined) ?? [] };
  }

  function renderHover(r: RenderHoverRequest): { hast: HastRoot } {
    return { hast: renderHastFast(previewMarkdown(r.content, r.fragment), undefined, requestHost) };
  }

  let queue: Promise<unknown> = Promise.resolve();

  return {
    handle(msg) {
      if (msg.type === "cancel") {
        see(msg);
        return Promise.resolve(null);
      }
      see(msg);
      const run = queue.then(async (): Promise<RenderReply> => {
        if (stale(msg)) return { id: msg.id, stale: true };
        current = { dark: msg.dark, host: msg.host, langs: new Set(msg.host.pluginLangs) };
        const started = now();
        try {
          const out = msg.type === "render" ? await renderDoc(msg) : msg.type === "hover" ? renderHover(msg) : await renderBlock(msg);
          if (stale(msg)) return { id: msg.id, stale: true };
          return { id: msg.id, ok: true, ...out, ms: now() - started };
        } catch (e) {
          return { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

