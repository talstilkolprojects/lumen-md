# ── Stage 1: Build ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests first (layer cache optimization). .npmrc skips
# the onnxruntime-node binary download (unused in the browser build).
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
# Deployment endpoints are baked in at build time (Vite) and added to the
# CSP connect-src, in the meta policy and in .csp-connect-extra (filled into
# the nginx header below). .dockerignore keeps .env* out of the context, so
# they arrive only as build args: `--build-arg`, or `[build.args]` in
# fly.toml. Keep in step with src/build/cspEndpoints.ts.
ARG VITE_WORKOS_ENDPOINT
ARG VITE_BILLING_ENDPOINT
ARG VITE_ENTITLEMENT_ENDPOINT
ARG VITE_PUBLISH_ENDPOINT
ARG VITE_RESEARCH_ENDPOINT
ARG VITE_AUDIT_ENDPOINT
ARG VITE_MARKETPLACE_URL
ARG VITE_LANGUAGETOOL_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
# CORS proxy for git in the browser (plan 3.3); empty = none.
ARG VITE_GIT_CORS_PROXY
# Error tracker (Sentry / GlitchTip). Public by design, not a secret; used
# only after the user turns error reports on (docs/src/content/docs/security/monitoring.md).
ARG VITE_SENTRY_DSN
# Lumen's model mirror (plan W4.14): the CORS proxy in front of the GitHub
# releases with a copy of every model file; empty = Hugging Face only.
ARG VITE_MODEL_MIRROR_URL
# Collaboration servers (signaling, comma-separated; persistent y-websocket).
ARG VITE_WEBRTC_SIGNALING_URL
ARG VITE_YJS_WEBSOCKET_URL
# Extra connect-src origins (runtime overrides: LAN Ollama, marketplace…).
ARG VITE_CSP_CONNECT_EXTRA
RUN npm run build
# LUMEN_RUNTIMES=full (default) keeps the same-origin WebAssembly runtimes the
# live blocks and on-device AI load (Pyodide, ruby.wasm, ONNX Runtime, the
# dictation VAD model, tesseract.js: ≈100 MB of dist/). `slim` drops them for an image that only
# needs the editor: live-python / live-ruby blocks, OCR and local
# transcription then report that their runtime is not installed. Everything
# else works the same: the Web Playground's vendor files, the plugin engine
# (QuickJS, ~0.5 MB) and the canvas fonts stay.
# webR (live R) is never in the image: GPL-3.0, so each user downloads it
# from the R block (plan W1.34).
ARG LUMEN_RUNTIMES=full
RUN case "$LUMEN_RUNTIMES" in \
      full) ;; \
      slim) rm -rf dist/pyodide dist/ruby dist/ort dist/vad dist/tesseract ;; \
      *) echo "LUMEN_RUNTIMES must be full or slim, got '$LUMEN_RUNTIMES'" >&2; exit 1 ;; \
    esac

# ── Stage 2: Serve ────────────────────────────────────────────────────────
# Use a minimal static-file server. The Lumen app is a fully static SPA;
# all it needs is an HTTP server that serves `dist/` with proper headers.
# This is the one web image (plan 13.2): fly.toml and docker-compose.yml
# both build it, and deploy/nginx.conf is the one nginx config, rendered
# from security/policy.json (`npm run headers`).
FROM nginx:alpine AS runtime

# Security: run as non-root
RUN adduser -D -u 1001 lumen && \
    chown -R lumen:lumen /var/cache/nginx /var/run /var/log/nginx

# Copy the custom nginx config
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/lumen-runtime-headers.conf /etc/nginx/lumen-runtime-headers.conf

# Copy the built assets from the builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Fill in the deployment's endpoint origins (VITE_*_ENDPOINT / _URL at build
# time, written by the Vite CSP plugin) — the header must allow them too.
RUN extra="$(cat /usr/share/nginx/html/.csp-connect-extra 2>/dev/null | tr -d '\n')"; \
    sed -i "s#__CSP_CONNECT_EXTRA__#${extra}#" /etc/nginx/nginx.conf /etc/nginx/lumen-runtime-headers.conf && \
    rm -f /usr/share/nginx/html/.csp-connect-extra

# Healthcheck for orchestrators (Docker Compose, Fly.io, K8s)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:8080/favicon.svg || exit 1

EXPOSE 8080

USER lumen

CMD ["nginx", "-g", "daemon off;"]
