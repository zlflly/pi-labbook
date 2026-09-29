import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildLabConversation, parsePreparedRecord } from "../src/index.js";

function custom(data: unknown): SessionEntry {
	return {
		type: "custom",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "pi-labbook",
		data,
	} as SessionEntry;
}

function message(role: "user" | "assistant", text: string): SessionEntry {
	return {
		type: "message",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: role === "user"
			? { role, content: [{ type: "text", text }], timestamp: Date.now() }
			: {
				role,
				content: [{ type: "text", text }],
				api: "test",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			},
	} as SessionEntry;
}

test("buildLabConversation includes only dialogue after the selected Lab start", () => {
	const start = { version: 1, event: "start", labId: "lab-1", anchorId: "a", kind: "note", topic: "t", startedAt: new Date().toISOString(), workspace: "/w", sessionId: "s" };
	const conversation = buildLabConversation([
		message("user", "before"),
		custom(start),
		message("user", "observation"),
		message("assistant", "follow-up"),
	], "lab-1");
	assert.equal(conversation, "User: observation\n\nAssistant: follow-up");
});

test("parsePreparedRecord accepts exact tagged JSON and rejects malformed output", () => {
	const payload = {
		title: "测试",
		summary: "摘要",
		method: [],
		observations: ["观察"],
		decisions: [],
		conclusion: "结论",
		nextSteps: [],
		artifacts: [],
		tags: ["test"],
	};
	assert.deepEqual(parsePreparedRecord(`<labbook_record>${JSON.stringify(payload)}</labbook_record>`), payload);
	assert.throws(() => parsePreparedRecord(JSON.stringify(payload)), /did not return/);
	assert.throws(() => parsePreparedRecord("<labbook_record>{bad}</labbook_record>"), /invalid JSON/);
});
