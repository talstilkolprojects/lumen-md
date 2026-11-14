// The parts of turndown 7 (MIT) the clipper uses (plan 4.15). Declared here
// instead of adding @types/turndown.
declare module "turndown" {
  interface Options {
    headingStyle?: "setext" | "atx";
    hr?: string;
    bulletListMarker?: "-" | "+" | "*";
    codeBlockStyle?: "indented" | "fenced";
    emDelimiter?: "_" | "*";
    strongDelimiter?: "__" | "**";
  }
  interface Rule {
    filter: string | string[] | ((node: HTMLElement, options: Options) => boolean);
    replacement: (content: string, node: HTMLElement, options: Options) => string;
  }
  export default class TurndownService {
    constructor(options?: Options);
    addRule(key: string, rule: Rule): this;
    remove(filter: string | string[]): this;
    turndown(html: string | Node): string;
  }
}
