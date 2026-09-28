/** The custom session-entry type owned by this extension. */
export const LABBOOK_ENTRY_TYPE = "pi-labbook" as const;

/**
 * Version of the data stored inside a {@link LABBOOK_ENTRY_TYPE} entry.
 *
 * This is deliberately separate from Pi's session-file version. Bump it when
 * the shape or meaning of the labbook events changes.
 */
export const LABBOOK_STATE_VERSION = 1 as const;

export const LABBOOK_KINDS = ["experiment", "note", "memory"] as const;

export type LabbookKind = (typeof LABBOOK_KINDS)[number];

interface LabbookEventBase {
	version: typeof LABBOOK_STATE_VERSION;
}

/** Marks a branch/navigation boundary. It clears any previously derived activity. */
export interface LabbookAnchorEvent extends LabbookEventBase {
	event: "anchor";
}

export interface LabbookStartEvent extends LabbookEventBase {
	event: "start";
	labId: string;
	anchorId: string;
	kind: LabbookKind;
	topic: string;
	startedAt: string;
	workspace: string;
	sessionId: string;
}

interface LabbookActivityEventBase extends LabbookEventBase {
	labId: string;
}

export interface LabbookSaveRequestedEvent extends LabbookActivityEventBase {
	event: "save_requested";
	requestId: string;
	requestedAt: string;
	guidance?: string;
}

export interface LabbookSavedEvent extends LabbookActivityEventBase {
	event: "saved";
	requestId: string;
	relativePath: string;
	commit: string;
	pushed: boolean;
	savedAt: string;
}

export interface LabbookSaveDeclinedEvent extends LabbookActivityEventBase {
	event: "save_declined";
	requestId: string;
	declinedAt: string;
}

export interface LabbookSaveFailedEvent extends LabbookActivityEventBase {
	event: "save_failed";
	requestId: string;
	message: string;
	failedAt: string;
}

export interface LabbookCancelledEvent extends LabbookActivityEventBase {
	event: "cancelled";
	cancelledAt: string;
	reason?: string;
}

/** Data persisted with `pi.appendEntry(LABBOOK_ENTRY_TYPE, event)`. */
export type LabbookEvent =
	| LabbookAnchorEvent
	| LabbookStartEvent
	| LabbookSaveRequestedEvent
	| LabbookSavedEvent
	| LabbookSaveDeclinedEvent
	| LabbookSaveFailedEvent
	| LabbookCancelledEvent;

/** The minimal shape of the Pi custom entry used by the state parser. */
export interface LabbookSessionEntry {
	type: "custom";
	customType: typeof LABBOOK_ENTRY_TYPE;
	data: LabbookEvent;
}

export type LabbookActivityStatus =
	| "started"
	| "save_requested"
	| "saved"
	| "save_declined"
	| "save_failed";

/**
 * State reconstructed for the active Pi branch.
 *
 * `start` is retained for every status so callers never need to search the
 * transcript again. In particular, `saved` is a real state rather than being
 * reduced to `undefined`; it therefore remains visible until a navigation
 * anchor, cancellation, or a branch that does not contain it is selected.
 */
export interface LabbookActivityState {
	status: LabbookActivityStatus;
	start: LabbookStartEvent;
	latest: LabbookStartEvent | LabbookSaveRequestedEvent | LabbookSavedEvent | LabbookSaveDeclinedEvent | LabbookSaveFailedEvent;
}

/** Structural subset of ExtensionContext, kept small to make the reducer testable. */
export interface LabbookBranchContext {
	sessionManager: {
		getBranch(): Iterable<unknown>;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isLabbookKind(value: unknown): value is LabbookKind {
	return typeof value === "string" && (LABBOOK_KINDS as readonly string[]).includes(value);
}

/**
 * Parse an unknown session entry as a supported labbook event.
 *
 * Unknown entry types, malformed data, and versions this extension does not
 * understand return `undefined`. Additional properties are tolerated so a
 * producer can add non-semantic metadata without breaking older readers.
 */
export function parseLabbookEntry(entry: unknown): LabbookEvent | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== LABBOOK_ENTRY_TYPE) {
		return undefined;
	}

	const data = entry.data;
	if (!isRecord(data) || data.version !== LABBOOK_STATE_VERSION || typeof data.event !== "string") {
		return undefined;
	}

	if (data.event === "start") {
		if (
			!isString(data.labId) ||
			!isString(data.anchorId) ||
			!isLabbookKind(data.kind) ||
			!isString(data.topic) ||
			!isString(data.startedAt) ||
			!isString(data.workspace) ||
			!isString(data.sessionId)
		) {
			return undefined;
		}

		return {
			version: LABBOOK_STATE_VERSION,
			event: "start",
			labId: data.labId,
			anchorId: data.anchorId,
			kind: data.kind,
			topic: data.topic,
			startedAt: data.startedAt,
			workspace: data.workspace,
			sessionId: data.sessionId,
		};
	}

	switch (data.event) {
		case "anchor":
			return { version: LABBOOK_STATE_VERSION, event: "anchor" };
		case "save_requested":
			if (!isString(data.labId) || !isString(data.requestId) || !isString(data.requestedAt)) return undefined;
			return {
				version: LABBOOK_STATE_VERSION,
				event: "save_requested",
				labId: data.labId,
				requestId: data.requestId,
				requestedAt: data.requestedAt,
				...(isString(data.guidance) ? { guidance: data.guidance } : {}),
			};
		case "saved":
			if (
				!isString(data.labId) || !isString(data.requestId) || !isString(data.relativePath) ||
				!isString(data.commit) || typeof data.pushed !== "boolean" || !isString(data.savedAt)
			) return undefined;
			return {
				version: LABBOOK_STATE_VERSION,
				event: "saved",
				labId: data.labId,
				requestId: data.requestId,
				relativePath: data.relativePath,
				commit: data.commit,
				pushed: data.pushed,
				savedAt: data.savedAt,
			};
		case "save_declined":
			if (!isString(data.labId) || !isString(data.requestId) || !isString(data.declinedAt)) return undefined;
			return {
				version: LABBOOK_STATE_VERSION,
				event: "save_declined",
				labId: data.labId,
				requestId: data.requestId,
				declinedAt: data.declinedAt,
			};
		case "save_failed":
			if (
				!isString(data.labId) || !isString(data.requestId) || !isString(data.message) || !isString(data.failedAt)
			) return undefined;
			return {
				version: LABBOOK_STATE_VERSION,
				event: "save_failed",
				labId: data.labId,
				requestId: data.requestId,
				message: data.message,
				failedAt: data.failedAt,
			};
		case "cancelled":
			if (!isString(data.labId) || !isString(data.cancelledAt)) return undefined;
			return {
				version: LABBOOK_STATE_VERSION,
				event: "cancelled",
				labId: data.labId,
				cancelledAt: data.cancelledAt,
				...(isString(data.reason) ? { reason: data.reason } : {}),
			};
		default:
			return undefined;
	}
}

/** Reduce already-selected branch entries in root-to-leaf order. */
export function deriveStateFromEntries(entries: Iterable<unknown>): LabbookActivityState | undefined {
	let state: LabbookActivityState | undefined;

	for (const entry of entries) {
		const parsed = parseLabbookEntry(entry);
		if (!parsed) continue;

		switch (parsed.event) {
			case "anchor":
			case "cancelled":
				state = undefined;
				break;
			case "start":
				state = { status: "started", start: parsed, latest: parsed };
				break;
			case "save_requested":
			case "saved":
			case "save_declined":
			case "save_failed":
				// Ignore orphaned or cross-lab markers. This also makes partially
				// written or manually edited session files safe to load.
				if (state && parsed.labId === state.start.labId) {
					state = { status: parsed.event, start: state.start, latest: parsed };
				}
				break;
		}
	}

	return state;
}

/**
 * Derive state only from Pi's active root-to-leaf branch.
 *
 * Deliberately do not use `getEntries()`: entries on abandoned sibling
 * branches must not affect restored extension state.
 */
export function deriveActiveBranchState(ctx: LabbookBranchContext): LabbookActivityState | undefined {
	return deriveStateFromEntries(ctx.sessionManager.getBranch());
}
