/**
 * Health of the deployed collab endpoints (plan 3.6.3): the WebRTC
 * signaling server (sync-server/server.js) and the persistent Hocuspocus
 * server (sync-server/collab-server.mjs). Used by scripts/collab-health.mjs.
 */

const httpBase = (wsUrl) => {
  const u = new URL(wsUrl);
  if (u.protocol === "wss:") u.protocol = "https:";
  else if (u.protocol === "ws:") u.protocol = "http:";
  u.pathname = u.pathname.replace(/\/+$/, "");
  u.search = "";
  return u.toString().replace(/\/$/, "");
};

async function healthz(wsUrl, timeoutMs) {
  const res = await fetch(`${httpBase(wsUrl)}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200) throw new Error(`/healthz answered HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

/** Open `url`, send `msg`, resolve with the first JSON reply. */
function wsRoundTrip(url, msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no reply from ${url} within ${timeoutMs} ms`));
    }, timeoutMs);
    const end = (fn) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* closed */
      }
      fn();
    };
    ws.onopen = () => ws.send(JSON.stringify(msg));
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data));
        end(() => resolve(data));
      } catch {
        end(() => reject(new Error(`non-JSON reply from ${url}`)));
      }
    };
    ws.onerror = () => end(() => reject(new Error(`cannot connect to ${url}`)));
  });
}

export async function checkSignaling(url, timeoutMs = 10_000) {
  await healthz(url, timeoutMs);
  const reply = await wsRoundTrip(url, { type: "ping" }, timeoutMs);
  if (reply?.type !== "pong") throw new Error(`signaling answered ${JSON.stringify(reply)} to a ping`);
}

export async function checkCollab(url, timeoutMs = 10_000) {
  const body = await healthz(url, timeoutMs);
  if (body?.service !== "lumen-collab") throw new Error(`/healthz is not the Lumen collab server: ${JSON.stringify(body)}`);
  // The token endpoint answers: a token (open server) or "unauthorized" (access key set). Both mean it is up.
  const reply = await wsRoundTrip(`${url.replace(/\/+$/, "")}/token`, { room: "health-check" }, timeoutMs);
  if (typeof reply?.token !== "string" && reply?.error !== "unauthorized") {
    throw new Error(`token endpoint answered ${JSON.stringify(reply)}`);
  }
}

/**
 * Check every configured endpoint. Returns {skipped, results}; `skipped`
 * is true when none is configured (before the deploy, owner action 15.4).
 */
export async function checkCollabHealth({ signalUrl, collabUrl, timeoutMs } = {}) {
  const checks = [
    ["signaling", signalUrl, checkSignaling],
    ["collab", collabUrl, checkCollab],
  ].filter(([, url]) => !!url);
  const results = [];
  for (const [name, url, check] of checks) {
    try {
      await check(url, timeoutMs);
      results.push({ name, url, ok: true });
    } catch (e) {
      results.push({ name, url, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { skipped: checks.length === 0, results };
}
