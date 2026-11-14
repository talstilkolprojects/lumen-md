/**
 * What counts as "the local network" for the LAN sync (plan W2.19).
 *
 * The LAN link never contacts a STUN or TURN server (no `iceServers`), so the
 * only ICE candidates are the devices' own addresses. On top of that every
 * candidate, ours and the other device's, must be a local-network address,
 * or it is dropped before WebRTC sees it:
 *
 *   IPv4  10/8, 172.16/12, 192.168/16 (private), 169.254/16 (link-local),
 *         127/8 (this device)
 *   IPv6  ::1, fe80::/10 (link-local), fc00::/7 (unique local)
 *   names `*.local` (mDNS; browsers hide the real address behind one)
 *
 * Carrier-grade NAT (100.64/10) and every public address are refused, and so
 * are server-reflexive and relay candidates, whatever their address.
 */

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** Expand an IPv6 address to its 8 groups, or null. */
function ipv6(host: string): number[] | null {
  let h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(h) || !h.includes(":")) return null;
  // An embedded IPv4 tail (::ffff:192.168.1.2).
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (v4) {
    const p = ipv4(v4[1]);
    if (!p) return null;
    h = h.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => g.length === 0 || g.length > 4)) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** Is `host` (an address or an mDNS name) on the local network or this device? */
export function isLanHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(h)) return true;
  if (h === "localhost") return true;
  const v4 = ipv4(h);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = ipv6(h);
  if (v6) {
    if (v6.every((g, i) => (i < 7 ? g === 0 : g === 1))) return true; // ::1
    if ((v6[0] & 0xffc0) === 0xfe80) return true; // link-local
    if ((v6[0] & 0xfe00) === 0xfc00) return true; // unique local
    // IPv4-mapped (::ffff:a.b.c.d): the IPv4 rule.
    if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
      return isLanHost(`${v6[6] >> 8}.${v6[6] & 255}.${v6[7] >> 8}.${v6[7] & 255}`);
    }
    return false;
  }
  return false;
}

export interface ParsedCandidate {
  address: string;
  port: number;
  type: string;
  protocol: string;
}

/** Parse an ICE candidate line (`candidate:… <ip> <port> typ <type> …`), with or without the `a=` prefix. */
export function parseCandidate(line: string): ParsedCandidate | null {
  const s = line.trim().replace(/^a=/, "");
  const m = /^candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/i.exec(s);
  if (!m) return null;
  return { protocol: m[1].toLowerCase(), address: m[2], port: Number(m[3]), type: m[4].toLowerCase() };
}

/** May this candidate be used? Host candidates on a local-network address only. */
export function candidateIsLan(line: string): boolean {
  const c = parseCandidate(line);
  return !!c && c.type === "host" && isLanHost(c.address);
}

/**
 * Drop every candidate line that isn't a LAN host candidate from an SDP
 * (offer or answer), and report what was dropped.
 */
export function lanOnlySdp(sdp: string): { sdp: string; dropped: string[]; kept: string[] } {
  const dropped: string[] = [];
  const kept: string[] = [];
  const lines = sdp.split(/\r?\n/).filter((l) => {
    if (!/^a=candidate:/i.test(l)) return true;
    const c = parseCandidate(l);
    if (c && candidateIsLan(l)) {
      kept.push(c.address);
      return true;
    }
    dropped.push(c?.address ?? l);
    return false;
  });
  return { sdp: lines.join("\r\n"), dropped, kept };
}
