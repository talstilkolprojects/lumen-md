/**
 * Drawing the graph (plan W1.10): WebGL for nodes (points) and links
 * (lines) — 10,000 nodes and 50,000 links are two draw calls a frame — with
 * a Canvas 2D fallback where WebGL is missing (tests, some VMs). Labels are
 * drawn by the view on a 2D overlay, where the browser shapes Hebrew and
 * lays it out right to left.
 *
 * Coordinates: world units from the layout; the view is a centre (x, y) and
 * a scale; screen = (world − centre) × scale + half the canvas.
 */

export interface GraphView {
  x: number;
  y: number;
  scale: number;
}

export interface RenderData {
  /** x, y per node. */
  positions: Float32Array;
  /** Pairs of node indices. */
  edges: Uint32Array;
  /** r, g, b, a (0–1) per node. */
  colors: Float32Array;
  /** Radius per node, in world units. */
  sizes: Float32Array;
  /** r, g, b, a of the links. */
  edgeColor: [number, number, number, number];
}

export interface Highlight {
  /** Nodes drawn with a ring (hover, keyboard focus). */
  nodes: number[];
  ring: [number, number, number, number];
}

export interface GraphRenderer {
  readonly kind: "webgl" | "canvas";
  setData(d: RenderData): void;
  /** New positions, same nodes and links (a layout frame). */
  setPositions(p: Float32Array): void;
  /**
   * Draw. `edgeLimit`: draw at most this many links — a uniform sample, as
   * the links are stored shuffled — for frames while the user zooms or pans
   * a big graph; the next still frame draws them all.
   */
  draw(view: GraphView, highlight?: Highlight, edgeLimit?: number): void;
  resize(width: number, height: number, dpr: number): void;
  dispose(): void;
}

const VS = `
attribute vec2 a_pos;
attribute vec4 a_color;
attribute float a_size;
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_half;
uniform float u_dpr;
varying vec4 v_color;
void main() {
  vec2 p = (a_pos - u_center) * u_scale / u_half;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  gl_PointSize = clamp(a_size * u_scale * 2.0, 2.0, 40.0) * u_dpr;
  v_color = a_color;
}`;
const FS_POINT = `
precision mediump float;
varying vec4 v_color;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  if (d > 0.5) discard;
  gl_FragColor = vec4(v_color.rgb, v_color.a * smoothstep(0.5, 0.42, d));
}`;
const FS_LINE = `
precision mediump float;
uniform vec4 u_color;
void main() { gl_FragColor = u_color; }`;

function compile(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
  return prog;
}

class WebGLRenderer implements GraphRenderer {
  readonly kind = "webgl" as const;
  private readonly point: WebGLProgram;
  private readonly line: WebGLProgram;
  private readonly posBuf: WebGLBuffer;
  private readonly colorBuf: WebGLBuffer;
  private readonly sizeBuf: WebGLBuffer;
  private readonly edgeBuf: WebGLBuffer;
  private readonly ringBuf: WebGLBuffer;
  private n = 0;
  private edgeCount = 0;
  private edgeColor: [number, number, number, number] = [0.5, 0.5, 0.5, 0.2];
  private positions: Float32Array = new Float32Array(0);
  private sizes: Float32Array = new Float32Array(0);
  private w = 1;
  private h = 1;
  private dpr = 1;

  constructor(
    private readonly gl: WebGLRenderingContext,
    private readonly uintIndex: boolean,
  ) {
    this.point = compile(gl, VS, FS_POINT);
    this.line = compile(gl, VS, FS_LINE);
    this.posBuf = gl.createBuffer()!;
    this.colorBuf = gl.createBuffer()!;
    this.sizeBuf = gl.createBuffer()!;
    this.edgeBuf = gl.createBuffer()!;
    this.ringBuf = gl.createBuffer()!;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  setData(d: RenderData) {
    const gl = this.gl;
    this.n = d.positions.length / 2;
    this.positions = d.positions;
    this.sizes = d.sizes;
    this.edgeColor = d.edgeColor;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d.colors, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d.sizes, gl.STATIC_DRAW);
    // Shuffled, so any prefix is a fair sample (see `edgeLimit`). Without
    // 32-bit indices (old WebGL 1), only links within the first 65,536 nodes are drawn.
    const shuffled = shuffledPairs(d.edges);
    const idx = this.uintIndex ? shuffled : Uint16Array.from(Array.from(shuffled).filter((_, i, a) => a[i - (i % 2)] < 65536 && a[i - (i % 2) + 1] < 65536));
    this.edgeCount = idx.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }

  setPositions(p: Float32Array) {
    this.positions = p;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, p, gl.DYNAMIC_DRAW);
  }

  private uniforms(prog: WebGLProgram, view: GraphView) {
    const gl = this.gl;
    gl.uniform2f(gl.getUniformLocation(prog, "u_center"), view.x, view.y);
    gl.uniform1f(gl.getUniformLocation(prog, "u_scale"), view.scale);
    gl.uniform2f(gl.getUniformLocation(prog, "u_half"), this.w / 2, this.h / 2);
    gl.uniform1f(gl.getUniformLocation(prog, "u_dpr"), this.dpr);
  }

  private attrib(prog: WebGLProgram, name: string, buf: WebGLBuffer, size: number) {
    const gl = this.gl;
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  private noAttrib(prog: WebGLProgram, name: string, ...value: number[]) {
    const gl = this.gl;
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.disableVertexAttribArray(loc);
    if (value.length === 1) gl.vertexAttrib1f(loc, value[0]);
    else gl.vertexAttrib4f(loc, value[0], value[1], value[2], value[3]);
  }

  draw(view: GraphView, highlight?: Highlight, edgeLimit?: number) {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.n) return;
    // Links.
    gl.useProgram(this.line);
    this.uniforms(this.line, view);
    gl.uniform4f(gl.getUniformLocation(this.line, "u_color"), ...this.edgeColor);
    this.attrib(this.line, "a_pos", this.posBuf, 2);
    this.noAttrib(this.line, "a_color", 0, 0, 0, 1);
    this.noAttrib(this.line, "a_size", 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeBuf);
    const count = edgeLimit === undefined ? this.edgeCount : Math.min(this.edgeCount, 2 * edgeLimit);
    if (count) gl.drawElements(gl.LINES, count, this.uintIndex ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    // Nodes.
    gl.useProgram(this.point);
    this.uniforms(this.point, view);
    this.attrib(this.point, "a_pos", this.posBuf, 2);
    this.attrib(this.point, "a_color", this.colorBuf, 4);
    this.attrib(this.point, "a_size", this.sizeBuf, 1);
    gl.drawArrays(gl.POINTS, 0, this.n);
    // Rings: the highlighted nodes again, bigger, in the ring colour, under a second copy.
    if (highlight?.nodes.length) {
      const pts = new Float32Array(highlight.nodes.length * 2);
      const sz = new Float32Array(highlight.nodes.length);
      highlight.nodes.forEach((i, k) => {
        pts[2 * k] = this.positions[2 * i];
        pts[2 * k + 1] = this.positions[2 * i + 1];
        sz[k] = (this.sizes[i] ?? 4) * 1.8 + 3 / view.scale;
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ringBuf);
      gl.bufferData(gl.ARRAY_BUFFER, pts, gl.DYNAMIC_DRAW);
      const loc = gl.getAttribLocation(this.point, "a_pos");
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.noAttrib(this.point, "a_color", ...highlight.ring);
      const sloc = gl.getAttribLocation(this.point, "a_size");
      for (let k = 0; k < sz.length; k++) {
        gl.vertexAttrib1f(sloc, sz[k]);
        gl.disableVertexAttribArray(sloc);
        gl.drawArrays(gl.POINTS, k, 1);
      }
    }
  }

  resize(width: number, height: number, dpr: number) {
    this.w = width;
    this.h = height;
    this.dpr = dpr;
  }

  dispose() {
    const gl = this.gl;
    for (const b of [this.posBuf, this.colorBuf, this.sizeBuf, this.edgeBuf, this.ringBuf]) gl.deleteBuffer(b);
    gl.deleteProgram(this.point);
    gl.deleteProgram(this.line);
  }
}

/** The fallback: Canvas 2D, drawing only what is on screen. */
class CanvasRenderer implements GraphRenderer {
  readonly kind = "canvas" as const;
  private d: RenderData | null = null;
  private w = 1;
  private h = 1;
  private dpr = 1;
  constructor(private readonly ctx: CanvasRenderingContext2D) {}
  setData(d: RenderData) {
    this.d = d;
  }
  setPositions(p: Float32Array) {
    if (this.d) this.d = { ...this.d, positions: p };
  }
  resize(width: number, height: number, dpr: number) {
    this.w = width;
    this.h = height;
    this.dpr = dpr;
  }
  draw(view: GraphView, highlight?: Highlight, edgeLimit?: number) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const d = this.d;
    if (!d) return;
    const sx = (x: number) => (x - view.x) * view.scale + this.w / 2;
    const sy = (y: number) => (y - view.y) * view.scale + this.h / 2;
    const rgba = (c: ArrayLike<number>, o = 0) => `rgba(${Math.round(c[o] * 255)}, ${Math.round(c[o + 1] * 255)}, ${Math.round(c[o + 2] * 255)}, ${c[o + 3]})`;
    ctx.strokeStyle = rgba(d.edgeColor);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const p = d.positions;
    const step = edgeLimit === undefined || d.edges.length / 2 <= edgeLimit ? 2 : 2 * Math.ceil(d.edges.length / 2 / edgeLimit);
    for (let e = 0; e < d.edges.length; e += step) {
      const a = d.edges[e];
      const b = d.edges[e + 1];
      ctx.moveTo(sx(p[2 * a]), sy(p[2 * a + 1]));
      ctx.lineTo(sx(p[2 * b]), sy(p[2 * b + 1]));
    }
    ctx.stroke();
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const x = sx(p[2 * i]);
      const y = sy(p[2 * i + 1]);
      if (x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) continue;
      ctx.fillStyle = rgba(d.colors, 4 * i);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, Math.min(20, d.sizes[i] * view.scale)), 0, Math.PI * 2);
      ctx.fill();
    }
    if (highlight) {
      ctx.strokeStyle = rgba(highlight.ring);
      ctx.lineWidth = 2;
      for (const i of highlight.nodes) {
        ctx.beginPath();
        ctx.arc(sx(p[2 * i]), sy(p[2 * i + 1]), Math.max(4, d.sizes[i] * view.scale) + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  dispose() {}
}

/** The link pairs in a fixed pseudo-random order (pairs kept together). */
export function shuffledPairs(edges: Uint32Array): Uint32Array {
  const out = Uint32Array.from(edges);
  const m = out.length / 2;
  let seed = 0x9e3779b9;
  for (let i = m - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const a0 = out[2 * i];
    const a1 = out[2 * i + 1];
    out[2 * i] = out[2 * j];
    out[2 * i + 1] = out[2 * j + 1];
    out[2 * j] = a0;
    out[2 * j + 1] = a1;
  }
  return out;
}

/** WebGL 2, else WebGL 1 (with 32-bit indices when it has them), else Canvas 2D. */
export function createRenderer(canvas: HTMLCanvasElement, opts: { preferCanvas?: boolean } = {}): GraphRenderer | null {
  if (!opts.preferCanvas) {
    try {
      const gl2 = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: false }) as WebGLRenderingContext | null;
      if (gl2) return new WebGLRenderer(gl2, true);
      const gl = canvas.getContext("webgl", { antialias: true, premultipliedAlpha: false });
      if (gl) return new WebGLRenderer(gl, !!gl.getExtension("OES_element_index_uint"));
    } catch {
      // why: no WebGL here: the canvas renderer below is used
      /* fall back */
    }
  }
  const ctx = canvas.getContext("2d");
  return ctx ? new CanvasRenderer(ctx) : null;
}

/** World → screen for one point. */
export const toScreen = (view: GraphView, width: number, height: number, x: number, y: number) => ({ x: (x - view.x) * view.scale + width / 2, y: (y - view.y) * view.scale + height / 2 });
/** Screen → world. */
export const toWorld = (view: GraphView, width: number, height: number, x: number, y: number) => ({ x: (x - width / 2) / view.scale + view.x, y: (y - height / 2) / view.scale + view.y });

/** A view that fits the positions in a width × height box. */
export function fitView(positions: Float32Array, width: number, height: number, margin = 40): GraphView {
  const n = positions.length / 2;
  if (!n) return { x: 0, y: 0, scale: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, positions[2 * i]);
    maxX = Math.max(maxX, positions[2 * i]);
    minY = Math.min(minY, positions[2 * i + 1]);
    maxY = Math.max(maxY, positions[2 * i + 1]);
  }
  const scale = Math.min((width - 2 * margin) / Math.max(1, maxX - minX), (height - 2 * margin) / Math.max(1, maxY - minY), 4);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale: Math.max(0.01, scale) };
}
