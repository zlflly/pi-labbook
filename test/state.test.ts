import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	LABBOOK_ENTRY_TYPE,
	LABBOOK_STATE_VERSION,
	deriveActiveBranchState,
	deriveStateFromEntries,
	parseLabbookEntry,
	type LabbookEvent,
	type LabbookStartEvent,
} from "../src/state.js";

const start: LabbookStartEvent = {
	version: LABBOOK_STATE_VERSION,
	event: "start",
	labId: "lab-42",
	anchorId: "before-lab",
	kind: "experiment",
	topic: "Tree branch behavior",
	startedAt: "2026-03-30T12:00:00.000Z",
	workspace: "/work/example",
	sessionId: "session-7",
};

const requested: LabbookEvent = {
	version: 1,
	event: "save_requested",
	labId: start.labId,
	requestId: "request-1",
	requestedAt: "2026-03-30T12:10:00.000Z",
};

const saved: LabbookEvent = {
	version: 1,
	event: "saved",
	labId: start.labId,
	requestId: "request-1",
	relativePath: "records/experiments/2026/03/test--lab-42.md",
	commit: "abc123",
	pushed: true,
	savedAt: "2026-03-30T12:11:00.000Z",
};

function entry(data: unknown, id = "entry"): Record<string, unknown> {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-03-30T12:00:00.000Z",
		customType: LABBOOK_ENTRY_TYPE,
		data,
	};
}

describe("parseLabbookEntry", () => {
	test("parses complete events and ignores unrelated entries", () => {
		assert.deepEqual(parseLabbookEntry(entry(start)), start);
		assert.deepEqual(parseLabbookEntry(entry(requested)), requested);
		assert.deepEqual(parseLabbookEntry(entry(saved)), saved);
		assert.equal(parseLabbookEntry({ type: "message" }), undefined);
		assert.equal(parseLabbookEntry(entry({ version: 2, event: "saved" })), undefined);
	});

	test("rejects malformed activity markers", () => {
		assert.equal(parseLabbookEntry(entry({ version: 1, event: "save_requested" })), undefined);
		assert.equal(parseLabbookEntry(entry({ ...saved, pushed: "yes" })), undefined);
	});
});

describe("branch state", () => {
	test("tracks start, request, and saved metadata", () => {
		const started = deriveStateFromEntries([entry(start)]);
		assert.equal(started?.status, "started");
		assert.deepEqual(started?.latest, start);

		const pending = deriveStateFromEntries([entry(start), entry(requested)]);
		assert.equal(pending?.status, "save_requested");
		assert.deepEqual(pending?.latest, requested);

		const complete = deriveStateFromEntries([entry(start), entry(requested), entry(saved)]);
		assert.equal(complete?.status, "saved");
		assert.deepEqual(complete?.latest, saved);
	});

	test("anchor and cancellation end active state", () => {
		assert.equal(
			deriveStateFromEntries([
				entry(start),
				entry({ version: 1, event: "cancelled", labId: start.labId, cancelledAt: "2026-03-30T12:12:00Z" }),
			]),
			undefined,
		);
		assert.equal(deriveStateFromEntries([entry(start), entry({ version: 1, event: "anchor" })]), undefined);
	});

	test("ignores cross-lab and orphaned markers", () => {
		const state = deriveStateFromEntries([
			entry(saved),
			entry(start),
			entry({ ...requested, labId: "another-lab" }),
		]);
		assert.equal(state?.status, "started");
	});

	test("derives only from the currently selected branch", () => {
		let branch: unknown[] = [entry(start), entry(requested), entry(saved)];
		const ctx = { sessionManager: { getBranch: () => branch } };
		assert.equal(deriveActiveBranchState(ctx)?.status, "saved");
		branch = [entry({ version: 1, event: "anchor" })];
		assert.equal(deriveActiveBranchState(ctx), undefined);
	});
});
