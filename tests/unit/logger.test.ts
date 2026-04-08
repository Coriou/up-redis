import { describe, expect, test } from "bun:test"
import { escapeControlChars } from "../../src/logger"

describe("escapeControlChars", () => {
	test("plain ASCII passes through unchanged", () => {
		expect(escapeControlChars("hello world")).toBe("hello world")
	})

	test("empty string passes through", () => {
		expect(escapeControlChars("")).toBe("")
	})

	test("escapes newline", () => {
		expect(escapeControlChars("a\nb")).toBe("a\\nb")
	})

	test("escapes carriage return", () => {
		expect(escapeControlChars("a\rb")).toBe("a\\rb")
	})

	test("escapes tab", () => {
		expect(escapeControlChars("a\tb")).toBe("a\\tb")
	})

	test("escapes null byte as \\x00", () => {
		expect(escapeControlChars("a\x00b")).toBe("a\\x00b")
	})

	test("escapes DEL (0x7F)", () => {
		expect(escapeControlChars("a\x7fb")).toBe("a\\x7fb")
	})

	test("escapes ANSI escape (0x1B)", () => {
		expect(escapeControlChars("a\x1b[31mfake-redb")).toBe("a\\x1b[31mfake-redb")
	})

	test("does not escape printable ASCII >= 0x20", () => {
		expect(escapeControlChars(" !\"#$%&'()*+,-./0123456789")).toBe(" !\"#$%&'()*+,-./0123456789")
	})

	test("does not escape unicode characters above 0x7F", () => {
		expect(escapeControlChars("café 🎉 日本語")).toBe("café 🎉 日本語")
	})

	test("forged log line injection is neutralized", () => {
		// Attacker tries to forge a fake [INFO] line via a Redis error message
		const malicious = "WRONGTYPE\n[INFO] 2026-01-01 fake admin login id=root"
		const escaped = escapeControlChars(malicious)
		expect(escaped).toBe("WRONGTYPE\\n[INFO] 2026-01-01 fake admin login id=root")
		// The escaped form contains no real newline → log line stays single-line
		expect(escaped.includes("\n")).toBe(false)
	})

	test("multiple control chars are all escaped", () => {
		expect(escapeControlChars("\n\r\t\x00\x1b")).toBe("\\n\\r\\t\\x00\\x1b")
	})
})
