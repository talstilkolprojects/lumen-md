import { describe, it, expect } from "vitest";
import { validateSchema, formatSchemaErrors } from "../agents/schema";

const tags = { type: "object", properties: { tags: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 8 } }, required: ["tags"], additionalProperties: false };

describe("agent output schema checker", () => {
  it("accepts matching values and rejects wrong shapes with paths", () => {
    expect(validateSchema({ tags: ["a", "b"] }, tags)).toEqual([]);
    expect(validateSchema([], tags)).toEqual([{ path: "$", message: "must be object, got array" }]);
    expect(validateSchema({}, tags)).toEqual([{ path: "$.tags", message: "is required" }]);
    expect(validateSchema({ tags: [] }, tags)).toEqual([{ path: "$.tags", message: "must have at least 1 items" }]);
    expect(validateSchema({ tags: ["a", 2] }, tags)).toEqual([{ path: "$.tags[1]", message: "must be string, got number" }]);
    expect(validateSchema({ tags: ["a"], extra: 1 }, tags)).toEqual([{ path: "$.extra", message: "is not allowed" }]);
    expect(validateSchema({ tags: [""] }, tags)).toEqual([{ path: "$.tags[0]", message: "must be at least 1 characters" }]);
  });

  it("handles enum, const, numbers, patterns, unions, nullable and integers", () => {
    expect(validateSchema("b", { enum: ["a", "b"] })).toEqual([]);
    expect(validateSchema("c", { enum: ["a", "b"] })[0].message).toMatch(/one of/);
    expect(validateSchema(3, { const: 3 })).toEqual([]);
    expect(validateSchema(4, { const: 3 })).toHaveLength(1);
    expect(validateSchema(1.5, { type: "integer" })).toHaveLength(1);
    expect(validateSchema(11, { type: "number", maximum: 10 })[0].message).toBe("must be ≤ 10");
    expect(validateSchema("x-1", { type: "string", pattern: "^[a-z]+-\\d$" })).toEqual([]);
    expect(validateSchema("X", { type: "string", pattern: "^[a-z]+$" })).toHaveLength(1);
    expect(validateSchema(null, { type: "string", nullable: true })).toEqual([]);
    expect(validateSchema(null, { type: ["string", "null"] })).toEqual([]);
    expect(validateSchema({ a: 1 }, { anyOf: [{ type: "string" }, { type: "object" }] })).toEqual([]);
    expect(validateSchema(1, { oneOf: [{ type: "number" }, { type: "integer" }] })[0].message).toMatch(/exactly one/);
    expect(validateSchema({ k: 1 }, { type: "object", additionalProperties: { type: "string" } })).toEqual([{ path: "$.k", message: "must be string, got number" }]);
    expect(validateSchema([1, 1], { type: "array", uniqueItems: true })).toHaveLength(1);
  });

  it("ignores keywords it does not know and formats errors compactly", () => {
    expect(validateSchema({ a: 1 }, { type: "object", $comment: "x", dependencies: {} })).toEqual([]);
    const errs = validateSchema({ a: "x", b: "y", c: "z" }, { type: "object", properties: { a: { type: "number" }, b: { type: "number" }, c: { type: "number" } } });
    expect(formatSchemaErrors(errs, 2)).toBe("$.a must be number, got string; $.b must be number, got string; +1 more");
  });
});
