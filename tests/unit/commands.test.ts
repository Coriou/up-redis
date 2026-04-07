import { describe, expect, test } from "bun:test";
import { checkBlockedCommand } from "../../src/commands";

describe("checkBlockedCommand", () => {
  // Subscriber mode commands
  test("SUBSCRIBE is blocked", () => {
    expect(checkBlockedCommand("SUBSCRIBE")).not.toBe(null);
  });

  test("PSUBSCRIBE is blocked", () => {
    expect(checkBlockedCommand("PSUBSCRIBE")).not.toBe(null);
  });

  test("SSUBSCRIBE is blocked", () => {
    expect(checkBlockedCommand("SSUBSCRIBE")).not.toBe(null);
  });

  test("UNSUBSCRIBE is blocked", () => {
    expect(checkBlockedCommand("UNSUBSCRIBE")).not.toBe(null);
  });

  test("PUNSUBSCRIBE is blocked", () => {
    expect(checkBlockedCommand("PUNSUBSCRIBE")).not.toBe(null);
  });

  test("SUNSUBSCRIBE is blocked", () => {
    expect(checkBlockedCommand("SUNSUBSCRIBE")).not.toBe(null);
  });

  // Monitor mode
  test("MONITOR is blocked", () => {
    expect(checkBlockedCommand("MONITOR")).not.toBe(null);
  });

  // Transaction commands
  test("MULTI is blocked with helpful message", () => {
    const msg = checkBlockedCommand("MULTI");
    expect(msg).toContain("/multi-exec");
  });

  test("EXEC is blocked with helpful message", () => {
    const msg = checkBlockedCommand("EXEC");
    expect(msg).toContain("/multi-exec");
  });

  test("DISCARD is blocked", () => {
    expect(checkBlockedCommand("DISCARD")).not.toBe(null);
  });

  test("WATCH is blocked", () => {
    expect(checkBlockedCommand("WATCH")).not.toBe(null);
  });

  test("UNWATCH is blocked", () => {
    expect(checkBlockedCommand("UNWATCH")).not.toBe(null);
  });

  // Database switching
  test("SELECT is blocked", () => {
    expect(checkBlockedCommand("SELECT")).not.toBe(null);
  });

  // Connection termination
  test("QUIT is blocked", () => {
    expect(checkBlockedCommand("QUIT")).not.toBe(null);
  });

  test("RESET is blocked", () => {
    expect(checkBlockedCommand("RESET")).not.toBe(null);
  });

  // Case insensitivity
  test("case insensitive: subscribe", () => {
    expect(checkBlockedCommand("subscribe")).not.toBe(null);
  });

  test("case insensitive: Multi", () => {
    expect(checkBlockedCommand("Multi")).not.toBe(null);
  });

  test("case insensitive: select", () => {
    expect(checkBlockedCommand("select")).not.toBe(null);
  });

  // Allowed commands
  test("GET is allowed", () => {
    expect(checkBlockedCommand("GET")).toBe(null);
  });

  test("SET is allowed", () => {
    expect(checkBlockedCommand("SET")).toBe(null);
  });

  test("HGETALL is allowed", () => {
    expect(checkBlockedCommand("HGETALL")).toBe(null);
  });

  test("PING is allowed", () => {
    expect(checkBlockedCommand("PING")).toBe(null);
  });

  test("DEL is allowed", () => {
    expect(checkBlockedCommand("DEL")).toBe(null);
  });

  test("PUBLISH is allowed", () => {
    expect(checkBlockedCommand("PUBLISH")).toBe(null);
  });

  test("CONFIG is allowed", () => {
    expect(checkBlockedCommand("CONFIG")).toBe(null);
  });

  // SUBSCRIBE hint
  test("SUBSCRIBE hint mentions /subscribe/:channel", () => {
    const msg = checkBlockedCommand("SUBSCRIBE");
    expect(msg).toContain("/subscribe/");
  });
});
