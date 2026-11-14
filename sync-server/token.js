/**
 * Access-token check for the persistent collab server (T49).
 * `tokenOk(url, expected)` is true when no token is configured, or when the
 * request URL carries ?token=<expected> (constant-time comparison).
 */
const crypto = require("crypto");

function tokenOk(url, expected) {
  if (!expected) return true;
  let given = "";
  try {
    given = new URL(url, "http://x").searchParams.get("token") || "";
  } catch {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { tokenOk };
