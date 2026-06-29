import { describe, expect, test } from "bun:test"
import { flattenScorePairs } from "../../src/translate/score-pairs"

describe("flattenScorePairs", () => {
	describe("WITHSCORES commands flatten member-score tuples", () => {
		test("ZRANGE WITHSCORES → flat array", () => {
			expect(
				flattenScorePairs(
					"ZRANGE",
					["z", "0", "-1", "WITHSCORES"],
					[
						["a", 1],
						["b", 2],
						["c", 3],
					],
				),
			).toEqual(["a", 1, "b", 2, "c", 3])
		})

		test("case-insensitive command + token", () => {
			expect(
				flattenScorePairs(
					"zrevrange",
					["z", "0", "-1", "withscores"],
					[
						["a", 1],
						["b", 2],
					],
				),
			).toEqual(["a", 1, "b", 2])
		})

		test("ZRANGEBYSCORE / ZREVRANGEBYSCORE / ZRANDMEMBER / ZUNION / ZINTER / ZDIFF", () => {
			for (const cmd of [
				"ZRANGEBYSCORE",
				"ZREVRANGEBYSCORE",
				"ZRANDMEMBER",
				"ZUNION",
				"ZINTER",
				"ZDIFF",
			]) {
				expect(flattenScorePairs(cmd, ["z", "WITHSCORES"], [["a", 1]])).toEqual(["a", 1])
			}
		})

		test("single member → flat pair", () => {
			expect(flattenScorePairs("ZRANGE", ["z", "0", "0", "WITHSCORES"], [["a", 5]])).toEqual([
				"a",
				5,
			])
		})

		test("empty result stays empty", () => {
			expect(flattenScorePairs("ZRANGE", ["z", "0", "-1", "WITHSCORES"], [])).toEqual([])
		})
	})

	describe("WITHVALUES commands", () => {
		test("HRANDFIELD WITHVALUES → flat array", () => {
			expect(
				flattenScorePairs(
					"HRANDFIELD",
					["h", "2", "WITHVALUES"],
					[
						["f1", "v1"],
						["f2", "v2"],
					],
				),
			).toEqual(["f1", "v1", "f2", "v2"])
		})
	})

	describe("ZPOPMIN/ZPOPMAX flatten only with a count argument", () => {
		test("with count → flat", () => {
			expect(
				flattenScorePairs(
					"ZPOPMIN",
					["z", "2"],
					[
						["a", 1],
						["b", 2],
					],
				),
			).toEqual(["a", 1, "b", 2])
			expect(flattenScorePairs("ZPOPMAX", ["z", "1"], [["c", 3]])).toEqual(["c", 3])
		})

		test("without count → unchanged (already a flat single pair)", () => {
			// ZPOPMIN key (no count) returns a flat [member, score], not nested
			expect(flattenScorePairs("ZPOPMIN", ["z"], ["a", 1])).toEqual(["a", 1])
		})
	})

	describe("does NOT touch legitimately-nested replies", () => {
		test("GEOPOS stays nested", () => {
			expect(flattenScorePairs("GEOPOS", ["geo", "Palermo"], [[13.36, 38.11]])).toEqual([
				[13.36, 38.11],
			])
		})

		test("ZRANGE WITHOUT WITHSCORES is untouched", () => {
			expect(flattenScorePairs("ZRANGE", ["z", "0", "-1"], ["a", "b", "c"])).toEqual([
				"a",
				"b",
				"c",
			])
		})

		test("non-targeted command untouched", () => {
			expect(flattenScorePairs("XRANGE", ["s", "-", "+"], [["id", ["f", "v"]]])).toEqual([
				["id", ["f", "v"]],
			])
		})

		test("non-array value passes through", () => {
			expect(flattenScorePairs("ZRANGE", ["z", "0", "-1", "WITHSCORES"], "OK")).toBe("OK")
			expect(flattenScorePairs("ZRANGE", ["z", "0", "-1", "WITHSCORES"], null)).toBe(null)
		})

		test("already-flat result is not double-flattened", () => {
			expect(flattenScorePairs("ZRANGE", ["z", "0", "-1", "WITHSCORES"], ["a", 1, "b", 2])).toEqual(
				["a", 1, "b", 2],
			)
		})
	})
})
