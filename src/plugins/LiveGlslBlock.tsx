/**
 * Live GLSL fragment-shader preview — type a GLSL ES 1.0 fragment
 * shader in the fence body, see it render on a full-width canvas with
 * the standard ShaderToy-style uniforms (`iTime`, `iResolution`,
 * `iMouse`).
 *
 * The vertex shader is a fixed full-screen triangle; the user only
 * supplies the fragment. Errors compile-time and link-time are
 * captured and printed below the canvas.
 *
 * Why this exists: GLSL is "what the browser supports" too — every
 * modern WebGL2 context will run it, and ShaderToy-style snippets are
 * a popular share format on Twitter / Bluesky.
 */

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG_PREFIX = `
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform vec4 iMouse;
`;

interface Props {
  source: string;
  meta?: string;
}

export default function LiveGlslBlock({ source, meta }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heightMatch = meta?.match(/height=(\d+)/);
  const height = heightMatch ? Number(heightMatch[1]) : 280;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Browsers explain WHY a context couldn't be created (blocklisted GPU,
    // no software fallback, headless…) only through this event.
    let reason = "";
    const onCreationError = (e: Event) => {
      reason = (e as WebGLContextEvent).statusMessage || reason;
    };
    canvas.addEventListener("webglcontextcreationerror", onCreationError);
    const gl = canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl") as WebGLRenderingContext | null;
    canvas.removeEventListener("webglcontextcreationerror", onCreationError);
    if (!gl) {
      setError(`WebGL is not available in this browser.${reason ? ` (${reason})` : ""}`);
      return;
    }
    setError(null);

    function compile(type: number, source: string): WebGLShader | null {
      const sh = gl!.createShader(type);
      if (!sh) return null;
      gl!.shaderSource(sh, source);
      gl!.compileShader(sh);
      if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
        const log = gl!.getShaderInfoLog(sh);
        setError(log ?? "shader compile failed");
        gl!.deleteShader(sh);
        return null;
      }
      return sh;
    }

    const vert = compile(gl.VERTEX_SHADER, VERT);
    // Auto-prefix uniforms unless the user already declared them.
    const userFrag = source.includes("iTime") || source.includes("iResolution")
      ? FRAG_PREFIX + "\n" + source
      : FRAG_PREFIX + "\n" + (source.includes("void main") ? source : `void main() { ${source} }`);
    const frag = compile(gl.FRAGMENT_SHADER, userFrag);
    if (!vert || !frag) return;

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setError(gl.getProgramInfoLog(prog) ?? "link failed");
      return;
    }
    gl.useProgram(prog);

    // Full-screen triangle.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(prog, "iTime");
    const uRes = gl.getUniformLocation(prog, "iResolution");
    const uMouse = gl.getUniformLocation(prog, "iMouse");

    let raf = 0;
    const start = performance.now();
    const mouse = { x: 0, y: 0, click: 0 };
    canvas.addEventListener("mousemove", (e) => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = r.height - (e.clientY - r.top);
    });
    canvas.addEventListener("mousedown", () => (mouse.click = 1));
    canvas.addEventListener("mouseup", () => (mouse.click = 0));

    function frame() {
      if (!canvas || !gl) return;
      // Resize backing store to match CSS size; cheap and cap at devicePixelRatio.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(uTime, (performance.now() - start) / 1000);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform4f(uMouse, mouse.x * dpr, mouse.y * dpr, mouse.click, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(raf);
  }, [source]);

  if (error) {
    return (
      <div className="chart-block" style={{ padding: 12 }}>
        <div style={{ color: "hsl(0 80% 60%)", fontFamily: "ui-monospace, monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {t("block.glsl.error")}{"\n"}{error}
        </div>
      </div>
    );
  }
  return (
    <div className="chart-block">
      <div className="chart-block-header">
        <span>{t("block.glsl.title")}</span>
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height,
          display: "block",
          background: "black",
        }}
      />
    </div>
  );
}
