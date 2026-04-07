import { describe, expect, test } from "bun:test";
import { normalizeResp3 } from "../../src/translate/response";

describe("normalizeResp3", () => {
  // Passthrough types
  test("string passes through", () => {
    expect(normalizeResp3("hello")).toBe("hello");
  });

  test("empty string passes through", () => {
    expect(normalizeResp3("")).toBe("");
  });

  test("integer passes through", () => {
    expect(normalizeResp3(42)).toBe(42);
  });

  test("float passes through", () => {
    expect(normalizeResp3(3.14)).toBe(3.14);
  });

  test("zero passes through", () => {
    expect(normalizeResp3(0)).toBe(0);
  });

  test("negative number passes through", () => {
    expect(normalizeResp3(-1)).toBe(-1);
  });

  test("null passes through", () => {
    expect(normalizeResp3(null)).toBe(null);
  });

  test("undefined becomes null", () => {
    expect(normalizeResp3(undefined)).toBe(null);
  });

  // Boolean → integer
  test("true becomes 1", () => {
    expect(normalizeResp3(true)).toBe(1);
  });

  test("false becomes 0", () => {
    expect(normalizeResp3(false)).toBe(0);
  });

  // Object → flat alternating array (RESP3 Map)
  test("simple object becomes flat array", () => {
    expect(normalizeResp3({ a: 1, b: 2 })).toEqual(["a", 1, "b", 2]);
  });

  test("empty object becomes empty array", () => {
    expect(normalizeResp3({})).toEqual([]);
  });

  test("object with string values", () => {
    expect(normalizeResp3({ field: "value", name: "Ben" })).toEqual([
      "field",
      "value",
      "name",
      "Ben",
    ]);
  });

  test("nested object flattens recursively", () => {
    expect(normalizeResp3({ a: { x: 1 } })).toEqual(["a", ["x", 1]]);
  });

  test("null-prototype object (Bun.redis RESP3 Map)", () => {
    const obj = Object.create(null);
    obj.field1 = "val1";
    obj.field2 = "val2";
    expect(normalizeResp3(obj)).toEqual(["field1", "val1", "field2", "val2"]);
  });

  // Array handling
  test("simple array passes through", () => {
    expect(normalizeResp3([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("empty array passes through", () => {
    expect(normalizeResp3([])).toEqual([]);
  });

  test("array with objects flattens each", () => {
    expect(normalizeResp3([{ a: 1 }])).toEqual([["a", 1]]);
  });

  test("array with booleans converts each", () => {
    expect(normalizeResp3([true, false])).toEqual([1, 0]);
  });

  test("array with null elements", () => {
    expect(normalizeResp3([null, "a", null])).toEqual([null, "a", null]);
  });

  test("deeply nested arrays", () => {
    expect(normalizeResp3([[["a"]]])).toEqual([[["a"]]]);
  });

  // Redis command simulations
  test("HGETALL simulation (RESP3 Map → flat array)", () => {
    const resp3Map = { field1: "val1", field2: "val2" };
    expect(normalizeResp3(resp3Map)).toEqual([
      "field1",
      "val1",
      "field2",
      "val2",
    ]);
  });

  test("XRANGE simulation (array of [id, Map])", () => {
    const resp3 = [["stream-id-1", { field: "value" }]];
    expect(normalizeResp3(resp3)).toEqual([
      ["stream-id-1", ["field", "value"]],
    ]);
  });

  test("CONFIG GET simulation (RESP3 Map)", () => {
    const resp3Map = { maxmemory: "0", maxclients: "10000" };
    expect(normalizeResp3(resp3Map)).toEqual([
      "maxmemory",
      "0",
      "maxclients",
      "10000",
    ]);
  });

  // Mixed nested structures
  test("mixed nested: object with array containing boolean and nested object", () => {
    expect(normalizeResp3({ k: [true, { x: "y" }] })).toEqual([
      "k",
      [1, ["x", "y"]],
    ]);
  });

  test("EXEC result simulation (array of mixed types)", () => {
    const execResult = ["OK", 42, null, { f: "v" }, [1, 2]];
    expect(normalizeResp3(execResult)).toEqual([
      "OK",
      42,
      null,
      ["f", "v"],
      [1, 2],
    ]);
  });

  // Edge cases
  test("bigint falls back to string", () => {
    expect(normalizeResp3(BigInt(999))).toBe("999");
  });

  test("object with boolean values", () => {
    expect(normalizeResp3({ exists: true, deleted: false })).toEqual([
      "exists",
      1,
      "deleted",
      0,
    ]);
  });

  // JavaScript Map → flat alternating array (safety net for RESP3)
  test("Map becomes flat alternating array", () => {
    const map = new Map<string, unknown>([
      ["a", 1],
      ["b", 2],
    ]);
    expect(normalizeResp3(map)).toEqual(["a", 1, "b", 2]);
  });

  test("Map with nested values normalizes recursively", () => {
    const map = new Map<string, unknown>([["key", { nested: true }]]);
    expect(normalizeResp3(map)).toEqual(["key", ["nested", 1]]);
  });

  test("empty Map becomes empty array", () => {
    expect(normalizeResp3(new Map())).toEqual([]);
  });

  // JavaScript Set → array (safety net for RESP3)
  test("Set becomes array", () => {
    const set = new Set([1, 2, 3]);
    expect(normalizeResp3(set)).toEqual([1, 2, 3]);
  });

  test("Set with mixed types normalizes each element", () => {
    const set = new Set([true, "hello", null]);
    const result = normalizeResp3(set) as unknown[];
    expect(result).toContain(1); // true → 1
    expect(result).toContain("hello");
    expect(result).toContain(null);
  });

  test("empty Set becomes empty array", () => {
    expect(normalizeResp3(new Set())).toEqual([]);
  });

  // Buffer/Uint8Array → UTF-8 string
  test("Buffer becomes UTF-8 string", () => {
    const buf = Buffer.from("hello", "utf-8");
    expect(normalizeResp3(buf)).toBe("hello");
  });

  test("Uint8Array becomes UTF-8 string", () => {
    const arr = new Uint8Array([104, 105]); // "hi"
    expect(normalizeResp3(arr)).toBe("hi");
  });

  test("empty Buffer becomes empty string", () => {
    expect(normalizeResp3(Buffer.alloc(0))).toBe("");
  });

  test("Buffer with unicode becomes UTF-8 string", () => {
    const buf = Buffer.from("café 🎉", "utf-8");
    expect(normalizeResp3(buf)).toBe("café 🎉");
  });

  // Map keys are coerced to strings
  test("Map with numeric keys coerces to strings", () => {
    const map = new Map<unknown, unknown>([
      [1, "one"],
      [2, "two"],
    ]);
    expect(normalizeResp3(map)).toEqual(["1", "one", "2", "two"]);
  });
});
