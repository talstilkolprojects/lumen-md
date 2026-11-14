/*
 * Lumen compare (plan W6.34): an Obsidian plugin for the owner's check.
 * Plain JavaScript, no build step; the Obsidian API from `require("obsidian")`.
 *
 * - Registers the Bases view type "lumen-export". A probe .base (written by
 *   `npm run obsidian:compare -- prepare`) has one view of that type; when
 *   Obsidian gives it data, the rows and groups are saved to
 *   _lumen-compare/results/<probe id>.json.
 * - The command "Run every probe" opens each probe in turn and waits for its
 *   result, then opens every original .base and .canvas and records whether
 *   Obsidian shows it in its own view (open-check.json).
 * Nothing leaves the vault; it writes only inside _lumen-compare/.
 */
const { Plugin, BasesView, Notice } = require("obsidian");

const TYPE = "lumen-export";
const DIR = "_lumen-compare";
const MARK = " ~lumen-probe ";
const probeId = (path) => path.replace(/\.base$/, "").replace(/[\\/]/g, "__").replace(/[^\p{L}\p{N}_ .~-]/gu, "_");
const text = (v) => (v === null || v === undefined ? "" : typeof v.toString === "function" ? String(v.toString()) : String(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ExportView extends BasesView {
  constructor(controller, parentEl, plugin) {
    super(controller);
    this.type = TYPE;
    this.plugin = plugin;
    this.el = parentEl.createDiv({ text: "Lumen compare: saving this view's rows…" });
  }
  onDataUpdated() {
    const groups = (this.data && this.data.groupedData) || [];
    const out = groups.map((g) => ({ key: g.key === null || g.key === undefined || text(g.key) === "null" ? "" : text(g.key), rows: (g.entries || []).map((e) => e.file.path) }));
    const rows = out.flatMap((g) => g.rows);
    this.el.setText(`Lumen compare: ${rows.length} rows`);
    this.plugin.received(out, rows);
  }
}

module.exports = class LumenCompare extends Plugin {
  async onload() {
    this.current = null;
    this.registerBasesView(TYPE, { name: "Lumen export", icon: "lucide-scale", factory: (controller, el) => new ExportView(controller, el, this) });
    this.addCommand({ id: "run-every-probe", name: "Run every probe", callback: () => this.runAll() });
  }

  received(groups, rows) {
    if (!this.current) return;
    this.current.groups = groups;
    this.current.rows = rows;
    this.current.at = Date.now();
  }

  async write(name, data) {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(`${DIR}/results`))) await adapter.mkdir(`${DIR}/results`);
    await adapter.write(`${DIR}/results/${name}`, JSON.stringify(data, null, 2) + "\n");
  }

  async runAll() {
    const files = this.app.vault.getFiles();
    const probes = files.filter((f) => f.extension === "base" && f.path.includes(MARK));
    const leaf = this.app.workspace.getLeaf(true);
    let done = 0;
    for (const f of probes) {
      this.current = { rows: null, groups: [], at: 0 };
      await leaf.openFile(f);
      // Wait until the view has data and it has been quiet for 600 ms (or 15 s).
      const start = Date.now();
      while (Date.now() - start < 15000) {
        await sleep(200);
        if (this.current.rows && Date.now() - this.current.at > 600) break;
      }
      if (this.current.rows) {
        await this.write(`${probeId(f.path)}.json`, { id: probeId(f.path), rows: this.current.rows, groups: this.current.groups });
        done++;
      }
    }
    this.current = null;
    // Lumen-saved .base and .canvas files: does Obsidian open each in its own view?
    const opened = [];
    for (const f of files.filter((x) => (x.extension === "base" || x.extension === "canvas") && !x.path.includes(MARK) && !x.path.startsWith(`${DIR}/`))) {
      await leaf.openFile(f);
      await sleep(400);
      const view = leaf.view && typeof leaf.view.getViewType === "function" ? leaf.view.getViewType() : "none";
      const want = f.extension === "base" ? "bases" : "canvas";
      const errorShown = !!leaf.view?.containerEl?.querySelector?.(".bases-error, .canvas-error, .mod-warning");
      opened.push({ path: f.path, view, ok: view === want && !errorShown });
    }
    await this.write("open-check.json", opened);
    new Notice(`Lumen compare: ${done}/${probes.length} probes saved; ${opened.filter((x) => x.ok).length}/${opened.length} files opened cleanly.`);
  }
};
