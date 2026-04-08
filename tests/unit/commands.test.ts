import { describe, expect, test } from "bun:test"
import { checkBlockedCommand } from "../../src/commands"

describe("checkBlockedCommand", () => {
	// Subscriber mode commands
	test("SUBSCRIBE is blocked", () => {
		expect(checkBlockedCommand("SUBSCRIBE")).not.toBe(null)
	})

	test("PSUBSCRIBE is blocked", () => {
		expect(checkBlockedCommand("PSUBSCRIBE")).not.toBe(null)
	})

	test("SSUBSCRIBE is blocked", () => {
		expect(checkBlockedCommand("SSUBSCRIBE")).not.toBe(null)
	})

	test("UNSUBSCRIBE is blocked", () => {
		expect(checkBlockedCommand("UNSUBSCRIBE")).not.toBe(null)
	})

	test("PUNSUBSCRIBE is blocked", () => {
		expect(checkBlockedCommand("PUNSUBSCRIBE")).not.toBe(null)
	})

	test("SUNSUBSCRIBE is blocked", () => {
		expect(checkBlockedCommand("SUNSUBSCRIBE")).not.toBe(null)
	})

	// Monitor mode
	test("MONITOR is blocked", () => {
		expect(checkBlockedCommand("MONITOR")).not.toBe(null)
	})

	// Transaction commands
	test("MULTI is blocked with helpful message", () => {
		const msg = checkBlockedCommand("MULTI")
		expect(msg).toContain("/multi-exec")
	})

	test("EXEC is blocked with helpful message", () => {
		const msg = checkBlockedCommand("EXEC")
		expect(msg).toContain("/multi-exec")
	})

	test("DISCARD is blocked", () => {
		expect(checkBlockedCommand("DISCARD")).not.toBe(null)
	})

	test("WATCH is blocked", () => {
		expect(checkBlockedCommand("WATCH")).not.toBe(null)
	})

	test("UNWATCH is blocked", () => {
		expect(checkBlockedCommand("UNWATCH")).not.toBe(null)
	})

	// Database switching
	test("SELECT is blocked", () => {
		expect(checkBlockedCommand("SELECT")).not.toBe(null)
	})

	// Connection termination
	test("QUIT is blocked", () => {
		expect(checkBlockedCommand("QUIT")).not.toBe(null)
	})

	test("RESET is blocked", () => {
		expect(checkBlockedCommand("RESET")).not.toBe(null)
	})

	// Case insensitivity
	test("case insensitive: subscribe", () => {
		expect(checkBlockedCommand("subscribe")).not.toBe(null)
	})

	test("case insensitive: Multi", () => {
		expect(checkBlockedCommand("Multi")).not.toBe(null)
	})

	test("case insensitive: select", () => {
		expect(checkBlockedCommand("select")).not.toBe(null)
	})

	// Blocking commands — would hold the shared connection
	test("BLPOP is blocked", () => {
		const msg = checkBlockedCommand("BLPOP")
		expect(msg).not.toBe(null)
		expect(msg).toContain("blocking")
	})

	test("BRPOP is blocked", () => {
		expect(checkBlockedCommand("BRPOP")).not.toBe(null)
	})

	test("BRPOPLPUSH is blocked", () => {
		expect(checkBlockedCommand("BRPOPLPUSH")).not.toBe(null)
	})

	test("BLMOVE is blocked", () => {
		expect(checkBlockedCommand("BLMOVE")).not.toBe(null)
	})

	test("BLMPOP is blocked", () => {
		expect(checkBlockedCommand("BLMPOP")).not.toBe(null)
	})

	test("BZPOPMIN is blocked", () => {
		expect(checkBlockedCommand("BZPOPMIN")).not.toBe(null)
	})

	test("BZPOPMAX is blocked", () => {
		expect(checkBlockedCommand("BZPOPMAX")).not.toBe(null)
	})

	test("BZMPOP is blocked", () => {
		expect(checkBlockedCommand("BZMPOP")).not.toBe(null)
	})

	test("WAIT is blocked", () => {
		expect(checkBlockedCommand("WAIT")).not.toBe(null)
	})

	test("WAITAOF is blocked", () => {
		expect(checkBlockedCommand("WAITAOF")).not.toBe(null)
	})

	// Server admin commands
	test("SHUTDOWN is blocked", () => {
		const msg = checkBlockedCommand("SHUTDOWN")
		expect(msg).not.toBe(null)
		expect(msg).toContain("admin")
	})

	test("REPLICAOF is blocked", () => {
		expect(checkBlockedCommand("REPLICAOF")).not.toBe(null)
	})

	test("SLAVEOF is blocked", () => {
		expect(checkBlockedCommand("SLAVEOF")).not.toBe(null)
	})

	test("FAILOVER is blocked", () => {
		expect(checkBlockedCommand("FAILOVER")).not.toBe(null)
	})

	test("DEBUG is blocked", () => {
		expect(checkBlockedCommand("DEBUG", "SLEEP")).not.toBe(null)
		expect(checkBlockedCommand("DEBUG", "OBJECT")).not.toBe(null)
	})

	// CLIENT subcommands — read-only allowed, dangerous blocked
	test("CLIENT KILL is blocked", () => {
		expect(checkBlockedCommand("CLIENT", "KILL")).not.toBe(null)
	})

	test("CLIENT PAUSE is blocked", () => {
		expect(checkBlockedCommand("CLIENT", "PAUSE")).not.toBe(null)
	})

	test("CLIENT UNPAUSE is blocked", () => {
		expect(checkBlockedCommand("CLIENT", "UNPAUSE")).not.toBe(null)
	})

	test("CLIENT REPLY is blocked", () => {
		expect(checkBlockedCommand("CLIENT", "REPLY")).not.toBe(null)
	})

	test("CLIENT NO-EVICT is blocked", () => {
		expect(checkBlockedCommand("CLIENT", "NO-EVICT")).not.toBe(null)
	})

	test("CLIENT SETNAME is blocked", () => {
		expect(checkBlockedCommand("CLIENT", "SETNAME")).not.toBe(null)
	})

	test("CLIENT SETINFO is blocked (per-connection state on shared connection)", () => {
		expect(checkBlockedCommand("CLIENT", "SETINFO")).not.toBe(null)
	})

	test("CLIENT NO-TOUCH is blocked (per-connection state on shared connection)", () => {
		expect(checkBlockedCommand("CLIENT", "NO-TOUCH")).not.toBe(null)
	})

	test("CLIENT subcommand check is case insensitive", () => {
		expect(checkBlockedCommand("CLIENT", "kill")).not.toBe(null)
		expect(checkBlockedCommand("client", "Kill")).not.toBe(null)
	})

	// Allowed CLIENT subcommands (read-only)
	test("CLIENT INFO is allowed", () => {
		expect(checkBlockedCommand("CLIENT", "INFO")).toBe(null)
	})

	test("CLIENT GETNAME is allowed", () => {
		expect(checkBlockedCommand("CLIENT", "GETNAME")).toBe(null)
	})

	test("CLIENT ID is allowed", () => {
		expect(checkBlockedCommand("CLIENT", "ID")).toBe(null)
	})

	test("CLIENT LIST is allowed", () => {
		expect(checkBlockedCommand("CLIENT", "LIST")).toBe(null)
	})

	test("CLIENT without subcommand is allowed", () => {
		expect(checkBlockedCommand("CLIENT")).toBe(null)
	})

	// CLUSTER subcommands — read-only allowed, topology mutators blocked
	test("CLUSTER FAILOVER is blocked", () => {
		const msg = checkBlockedCommand("CLUSTER", "FAILOVER")
		expect(msg).not.toBe(null)
		expect(msg).toContain("CLUSTER FAILOVER")
	})

	test("CLUSTER RESET is blocked", () => {
		expect(checkBlockedCommand("CLUSTER", "RESET")).not.toBe(null)
	})

	test("CLUSTER MEET is blocked", () => {
		expect(checkBlockedCommand("CLUSTER", "MEET")).not.toBe(null)
	})

	test("CLUSTER FORGET is blocked", () => {
		expect(checkBlockedCommand("CLUSTER", "FORGET")).not.toBe(null)
	})

	test("CLUSTER REPLICATE is blocked", () => {
		expect(checkBlockedCommand("CLUSTER", "REPLICATE")).not.toBe(null)
	})

	test("CLUSTER ADDSLOTS is blocked", () => {
		expect(checkBlockedCommand("CLUSTER", "ADDSLOTS")).not.toBe(null)
	})

	test("CLUSTER DELSLOTS is blocked", () => {
		expect(checkBlockedCommand("CLUSTER", "DELSLOTS")).not.toBe(null)
	})

	test("CLUSTER SETSLOT is blocked", () => {
		expect(checkBlockedCommand("CLUSTER", "SETSLOT")).not.toBe(null)
	})

	test("CLUSTER FAILOVER subcommand check is case insensitive", () => {
		expect(checkBlockedCommand("cluster", "failover")).not.toBe(null)
		expect(checkBlockedCommand("Cluster", "Failover")).not.toBe(null)
	})

	// Allowed CLUSTER subcommands (read-only)
	test("CLUSTER INFO is allowed", () => {
		expect(checkBlockedCommand("CLUSTER", "INFO")).toBe(null)
	})

	test("CLUSTER NODES is allowed", () => {
		expect(checkBlockedCommand("CLUSTER", "NODES")).toBe(null)
	})

	test("CLUSTER MYID is allowed", () => {
		expect(checkBlockedCommand("CLUSTER", "MYID")).toBe(null)
	})

	test("CLUSTER SHARDS is allowed", () => {
		expect(checkBlockedCommand("CLUSTER", "SHARDS")).toBe(null)
	})

	test("CLUSTER SLOTS is allowed", () => {
		expect(checkBlockedCommand("CLUSTER", "SLOTS")).toBe(null)
	})

	test("CLUSTER without subcommand is allowed", () => {
		expect(checkBlockedCommand("CLUSTER")).toBe(null)
	})

	// Allowed commands
	test("GET is allowed", () => {
		expect(checkBlockedCommand("GET")).toBe(null)
	})

	test("SET is allowed", () => {
		expect(checkBlockedCommand("SET")).toBe(null)
	})

	test("HGETALL is allowed", () => {
		expect(checkBlockedCommand("HGETALL")).toBe(null)
	})

	test("PING is allowed", () => {
		expect(checkBlockedCommand("PING")).toBe(null)
	})

	test("DEL is allowed", () => {
		expect(checkBlockedCommand("DEL")).toBe(null)
	})

	test("PUBLISH is allowed", () => {
		expect(checkBlockedCommand("PUBLISH")).toBe(null)
	})

	test("CONFIG is allowed", () => {
		expect(checkBlockedCommand("CONFIG")).toBe(null)
	})

	test("LPOP (non-blocking) is allowed", () => {
		expect(checkBlockedCommand("LPOP")).toBe(null)
	})

	test("RPOP (non-blocking) is allowed", () => {
		expect(checkBlockedCommand("RPOP")).toBe(null)
	})

	test("ZPOPMIN (non-blocking) is allowed", () => {
		expect(checkBlockedCommand("ZPOPMIN")).toBe(null)
	})

	// SUBSCRIBE hint
	test("SUBSCRIBE hint mentions /subscribe/:channel", () => {
		const msg = checkBlockedCommand("SUBSCRIBE")
		expect(msg).toContain("/subscribe/")
	})
})
