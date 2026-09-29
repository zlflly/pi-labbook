import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildLabConversation, extractStreamingPreview, parsePreparedRecord, sanitizeGeneratedText } from "../src/index.js";

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

test("streaming preview grows before metadata is complete", () => {
	assert.equal(extractStreamingPreview("<labbook_pre"), "");
	assert.equal(extractStreamingPreview("<labbook_preview>\n## Summary\n\n测"), "## Summary\n\n测");
	assert.equal(
		extractStreamingPreview("<labbook_preview>\n## Summary\n\n测试\n</labbook_preview><labbook_metadata>"),
		"## Summary\n\n测试\n",
	);
});

test("streamed preview strips terminal control sequences before display or save", () => {
	const hostile = "safe\u001b]52;c;Y2xpcGJvYXJk\u0007 text\u0007 \u001b[31mred\u001b[0m\u009b31m";
	assert.equal(sanitizeGeneratedText(hostile), "safe text red");
});

test("parsePreparedRecord accepts preview plus metadata and rejects malformed output", () => {
	const metadata = { title: "测试", summary: "摘要", tags: ["test"] };
	const output = `<labbook_preview>\n## Summary\n\n测试内容\n</labbook_preview>\n<labbook_metadata>${JSON.stringify(metadata)}</labbook_metadata>`;
	assert.deepEqual(parsePreparedRecord(output), { ...metadata, body: "## Summary\n\n测试内容" });
	assert.throws(() => parsePreparedRecord(JSON.stringify(metadata)), /complete <labbook_preview>/);
	assert.throws(
		() => parsePreparedRecord("<labbook_preview>body</labbook_preview><labbook_metadata>{bad}</labbook_metadata>"),
		/invalid metadata JSON/,
	);
});
