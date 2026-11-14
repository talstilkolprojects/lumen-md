/**
 * A small LRU cache keyed by a hash of a block's content (plan 8.1 step 2:
 * Shiki and KaTeX output kept per code block / formula).
 *
 * The map is keyed by a 53-bit hash of the key text; each entry keeps the
 * text too, so two texts with the same hash never share an entry. Values
 * are HAST, handed out as they are: callers clone before they splice.
 */

/** cyrb53: a fast 53-bit string hash (public domain, bryc). */
export function hash53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export class BlockCache<V> {
  private readonly map = new Map<number, { key: string; value: V }>();
  constructor(private readonly max: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const h = hash53(key);
    const e = this.map.get(h);
    if (!e || e.key !== key) return undefined;
    // Most recently used goes last.
    this.map.delete(h);
    this.map.set(h, e);
    return e.value;
  }

  set(key: string, value: V): void {
    const h = hash53(key);
    this.map.delete(h);
    this.map.set(h, { key, value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as number);
  }

  clear(): void {
    this.map.clear();
  }
}
