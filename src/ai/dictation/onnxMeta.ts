/**
 * The custom metadata of an ONNX model (`ModelProto.metadata_props`), read
 * straight from the protobuf: sherpa-onnx's exports describe the streaming
 * encoder there (layer dims, left context, chunk length), and ONNX Runtime
 * Web does not expose it. Only the top-level fields are walked; the graph
 * (the weights) is skipped by its length.
 */

function varint(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (;;) {
    if (at >= b.length) throw new Error("onnx: truncated varint");
    const x = b[at++];
    v += (x & 0x7f) * mul;
    if (x < 0x80) return [v, at];
    mul *= 128;
  }
}

const utf8 = new TextDecoder();

/** Key → value of `metadata_props` (field 14 of ModelProto). */
export function onnxMetadata(model: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < model.length) {
    let tag: number;
    [tag, at] = varint(model, at);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      [, at] = varint(model, at);
    } else if (wire === 1) {
      at += 8;
    } else if (wire === 5) {
      at += 4;
    } else if (wire === 2) {
      let len: number;
      [len, at] = varint(model, at);
      if (field === 14) {
        const entry = model.subarray(at, at + len);
        let p = 0;
        let key = "";
        let value = "";
        while (p < entry.length) {
          let t: number;
          [t, p] = varint(entry, p);
          let l: number;
          [l, p] = varint(entry, p);
          const s = utf8.decode(entry.subarray(p, p + l));
          if (t >> 3 === 1) key = s;
          else if (t >> 3 === 2) value = s;
          p += l;
        }
        out[key] = value;
      }
      at += len;
    } else {
      throw new Error(`onnx: unsupported wire type ${wire}`);
    }
  }
  return out;
}

/** A comma-separated integer list from the metadata ("2,2,3,4,3,2"). */
export const intList = (meta: Record<string, string>, key: string): number[] => {
  const v = meta[key];
  if (v == null) throw new Error(`onnx: metadata ${key} missing`);
  return v.split(",").map((x) => Number.parseInt(x.trim(), 10));
};
