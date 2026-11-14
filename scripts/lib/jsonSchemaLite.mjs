/**
 * A small JSON Schema (draft-07) validator for the keywords the vendored
 * winget schemas use (plan W1.24): type, $ref to #/definitions, properties,
 * required, additionalProperties, items, enum, const, pattern, min/maxLength,
 * min/maxItems, uniqueItems, minimum/maximum, not, oneOf. `format` is not
 * checked. Zero dependencies, so the packaging check runs offline.
 *
 *   validate(schema, value) → ["$.Installers[0].InstallerUrl: does not match ^https?://…", …]
 */
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => t === typeOf(v) || (t === "number" && typeof v === "number");

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`only local $ref is supported: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((o, k) => {
      if (!o || !(k in o)) throw new Error(`$ref not found: ${ref}`);
      return o[k];
    }, root);
}

export function validate(root, value, schema = root, at = "$", out = []) {
  if (schema === true || schema == null) return out;
  if (schema === false) return (out.push(`${at}: not allowed`), out);
  if (schema.$ref) return validate(root, value, resolveRef(root, schema.$ref), at, out);
  const fail = (m) => out.push(`${at}: ${m}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) return (fail(`is ${typeOf(value)}, expected ${types.join(" | ")}`), out);
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) fail(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) fail(`must be one of ${schema.enum.join(", ")}`);
  if (schema.not && !validate(root, value, schema.not, at, []).length) fail("matches a value that is not allowed");
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => !validate(root, value, s, at, []).length).length;
    if (ok !== 1) fail(`must match exactly one of ${schema.oneOf.length} schemas (matches ${ok})`);
  }
  if (typeof value === "string") {
    if (schema.minLength != null && [...value].length < schema.minLength) fail(`shorter than ${schema.minLength}`);
    if (schema.maxLength != null && [...value].length > schema.maxLength) fail(`longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) fail(`does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) fail(`below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) fail(`above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) fail("items are not unique");
    if (schema.items) value.forEach((v, i) => validate(root, v, schema.items, `${at}[${i}]`, out));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) fail(`missing ${k}`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) validate(root, v, props[k], `${at}.${k}`, out);
      else if (schema.additionalProperties === false) fail(`unknown property ${k}`);
      else if (typeof schema.additionalProperties === "object") validate(root, v, schema.additionalProperties, `${at}.${k}`, out);
    }
  }
  return out;
}
