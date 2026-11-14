/**
 * WYSIWYG editor: images from other sites wait for the user (plan 2.2).
 *
 * The commonmark preset renders an image node as a bare <img src>, which
 * would request a note's tracking pixel the moment it is opened in this
 * mode. This node view renders the same placeholder as the preview
 * (src/renderer/components.tsx) until the image may load, and the real
 * <img> once it may. Copy / paste still serialize the node through its
 * schema (in an inert document, so no request).
 */
import { Plugin } from "@milkdown/prose/state";
import type { Node as PmNode } from "@milkdown/prose/model";
import type { NodeView } from "@milkdown/prose/view";
import { t } from "../i18n";
import {
  allowRemoteImageHosts,
  loadRemoteImagesOnce,
  remoteImageGate,
  remoteImagesUnavailable,
  subscribeRemoteImages,
  type RemoteImageGate,
} from "../lib/remoteImages";

/** The placeholder as DOM (the preview renders the same markup with React). */
export function remoteImagePlaceholder(alt: string, gate: RemoteImageGate, doc: Document = document): HTMLElement {
  const host = gate.hosts.join(", ");
  const unavailable = remoteImagesUnavailable();
  const el = (tag: string, cls?: string, text?: string) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = el("span", "lumen-remote-image");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", t("remoteImage.label", { host }));
  root.dataset.remoteImage = host;
  const text = el("span", "lumen-remote-image-text");
  const altEl = el("span", "lumen-remote-image-alt", alt.trim() || t("remoteImage.untitled"));
  const hostEl = el("span", "lumen-remote-image-host", unavailable ? t("remoteImage.desktop", { host }) : t("remoteImage.blocked", { host }));
  altEl.dir = "auto";
  hostEl.dir = "auto";
  text.append(altEl, hostEl);
  root.append(text);
  if (!unavailable) {
    const button = (label: string, title: string, onClick: () => void) => {
      const b = el("button", undefined, label) as HTMLButtonElement;
      b.type = "button";
      b.title = title;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        onClick();
      });
      return b;
    };
    root.append(
      button(t("remoteImage.load"), t("remoteImage.loadHint", { host }), () => loadRemoteImagesOnce(gate.urls)),
      button(t("remoteImage.allowHost", { host }), t("remoteImage.allowHint", { host }), () => allowRemoteImageHosts(gate.hosts)),
    );
  }
  return root;
}

interface ImageAttrs {
  src?: string;
  alt?: string;
  title?: string;
}

export class RemoteImageView implements NodeView {
  dom: HTMLElement;
  private node: PmNode;
  private shown = "";
  private readonly unsubscribe: () => void;

  constructor(node: PmNode) {
    this.node = node;
    this.dom = document.createElement("span");
    this.dom.className = "lumen-wysiwyg-image";
    this.render();
    this.unsubscribe = subscribeRemoteImages(() => this.render());
  }

  private render() {
    const { src = "", alt = "", title = "" } = this.node.attrs as ImageAttrs;
    const gate = remoteImageGate(src);
    const key = JSON.stringify([src, alt, title, gate.blocked]);
    if (key === this.shown) return;
    this.shown = key;
    if (gate.blocked) {
      this.dom.replaceChildren(remoteImagePlaceholder(alt, gate));
      return;
    }
    const img = document.createElement("img");
    if (alt) img.alt = alt;
    if (title) img.title = title;
    img.src = src;
    this.dom.replaceChildren(img);
  }

  update(node: PmNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  /** The placeholder's buttons are ours; ProseMirror must not select the node on them. */
  stopEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof Element && target.closest("button") !== null;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.unsubscribe();
  }
}

/** ProseMirror plugin that installs the node view for `image` nodes. */
export function remoteImagePlugin(): Plugin {
  return new Plugin({
    props: {
      nodeViews: {
        image: (node) => new RemoteImageView(node),
      },
    },
  });
}
