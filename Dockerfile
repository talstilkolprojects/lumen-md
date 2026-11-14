# ── Stage 1: Build ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests first (layer cache optimization)
COPY package.json package-lock.json ./
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
# Collaboration servers (signaling, comma-separated; persistent y-websocket).
ARG VITE_WEBRTC_SIGNALING_URL
ARG VITE_YJS_WEBSOCKET_URL
# Extra connect-src origins (runtime overrides: LAN Ollama, marketplace…).
ARG VITE_CSP_CONNECT_EXTRA
RUN npm run build

# ── Stage 2: Serve ────────────────────────────────────────────────────────
# Use a minimal static-file server. The Lumen app is a fully static SPA;
# all it needs is an HTTP server that serves `dist/` with proper headers.
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
