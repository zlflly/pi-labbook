import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildLabConversation,
	findAssistantRecordAfterRequest,
	parseVisibleRecord,
	sanitizeGeneratedText,
} from "../src/index.js";
import { deriveStateFromEntries } from "../src/state.js";

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

function message(role: "user" | "assistant", text: string, stopReason = "stop"): SessionEntry {
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
				stopReason,
				timestamp: Date.now(),
			},
	} as SessionEntry;
}

const start = {
	version: 1,
	event: "start",
	labId: "lab-1",
	anchorId: "a",
	kind: "note",
	topic: "测试主题",
	startedAt: new Date().toISOString(),
	workspace: "/w",
	sessionId: "s",
};

const request = {
	version: 1,
	event: "save_requested",
	labId: "lab-1",
	requestId: "request-1",
	requestedAt: new Date().toISOString(),
};

test("buildLabConversation includes only dialogue after the selected Lab start", () => {
	const conversation = buildLabConversation([
		message("user", "before"),
		custom(start),
		message("user", "observation"),
		message("assistant", "follow-up"),
	], "lab-1");
	assert.equal(conversation, "User: observation\n\nAssistant: follow-up");
});

test("generated Markdown strips terminal control sequences before save", () => {
	const hostile = "safe\u001b]52;c;Y2xpcGJvYXJk\u0007 text\u0007 \u001b[31mred\u001b[0m\u009b31m";
	assert.equal(sanitizeGeneratedText(hostile), "safe text red");
});

test("parseVisibleRecord uses the streamed H1 and summary section", () => {
	const state = deriveStateFromEntries([custom(start), custom(request)]);
	assert.ok(state);
	const draft = parseVisibleRecord("# 测试记录\n\n## Summary\n\n这是摘要。\n\n## Details\n\n正文。", state);
	assert.deepEqual(draft, {
		title: "测试记录",
		summary: "这是摘要。",
		body: "## Summary\n\n这是摘要。\n\n## Details\n\n正文。",
		tags: ["note"],
	});
});

test("findAssistantRecordAfterRequest ignores earlier and incomplete assistant messages", () => {
	const branch = [
		custom(start),
		message("assistant", "earlier"),
		custom(request),
		message("assistant", "# incomplete", "length"),
		message("assistant", "# Final\n\n## Summary\n\nDone"),
	];
	assert.equal(findAssistantRecordAfterRequest(branch, "request-1"), "# Final\n\n## Summary\n\nDone");
});
