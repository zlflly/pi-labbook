import { randomUUID } from "node:crypto";
import type { UserMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, stripTerminalSequences, Text, VStack } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { configPath, loadConfig } from "./config.js";
import { createLabRecord, renderLabRecord, type LabSaveParams } from "./record.js";
import { inspectRepository, publishRecord, recordPathForConfig, sanitizeRemoteForDisplay, validateRepositoryForPublish } from "./repository.js";
import {
	LABBOOK_ENTRY_TYPE,
	LABBOOK_KINDS,
	LABBOOK_STATE_VERSION,
	deriveActiveBranchState,
	parseLabbookEntry,
	type LabbookActivityState,
	type LabbookKind,
	type LabbookSavedEvent,
	type LabbookSaveRequestedEvent,
} from "./state.js";

const STATUS_KEY = "pi-labbook";
const LEGACY_TOOL_NAME = "labbook_save";
const MAX_CONVERSATION_CHARS = 60_000;

const MetadataSchema = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 200 }),
		summary: Type.String({ minLength: 1, maxLength: 1000 }),
		tags: Type.Array(Type.String({ minLength: 1, maxLength: 48 }), { maxItems: 32 }),
	},
	{ additionalProperties: false },
);

type PreparedMetadata = {
	title: string;
	summary: string;
	tags: string[];
};

type PreparedDraft = PreparedMetadata & {
	body: string;
};

const EXTRACTION_PROMPT = `You turn one Pi Lab discussion into a faithful Markdown record.
Use only facts present in the conversation. Never invent methods, observations, decisions, conclusions, artifacts, or next steps.
Keep observations separate from decisions and conclusions.
Write in the user's language. Preserve exact commands, paths, model names, hosts, ports, errors, and identifiers.

Output exactly these two blocks and no other text:
<labbook_preview>
The complete Markdown body without YAML frontmatter and without an H1 title.
</labbook_preview>
<labbook_metadata>{"title":"...","summary":"...","tags":["..."]}</labbook_metadata>

The preview is the exact body the user will review and save. Do not mention these formatting instructions in it.
Choose headings for the record type:
- experiment: Summary, Objective, Hypothesis (only if actually discussed), Environment, Method, Observations, Decisions, Conclusion, Next steps, Artifacts.
- note: Summary, Context, Key points, Details, Decisions, Open questions, References.
- memory: Statement, When to apply, Evidence, Exceptions, Source, Last verified.
Omit optional sections with no established information instead of inventing placeholders.`;

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function buildLabConversation(branch: readonly SessionEntry[], labId: string): string {
	let started = false;
	const sections: string[] = [];
	for (const entry of branch) {
		const event = parseLabbookEntry(entry);
		if (event?.event === "start" && event.labId === labId) {
			started = true;
			continue;
		}
		if (!started || entry.type !== "message") continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(entry.message.content).trim();
		if (text) sections.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	const conversation = sections.join("\n\n");
	if (conversation.length <= MAX_CONVERSATION_CHARS) return conversation;
	return `[Earlier Lab discussion omitted]\n${conversation.slice(-MAX_CONVERSATION_CHARS)}`;
}

export function sanitizeGeneratedText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\u009D[\s\S]*?(?:\u009C|\u0007)/g, "")
		.replace(/\u009B[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

export function extractStreamingPreview(text: string): string {
	const startMarker = "<labbook_preview>";
	const endMarker = "</labbook_preview>";
	const start = text.indexOf(startMarker);
	if (start < 0) return "";
	const contentStart = start + startMarker.length;
	const end = text.indexOf(endMarker, contentStart);
	return text.slice(contentStart, end < 0 ? undefined : end).replace(/^\s+/, "");
}

export function parsePreparedRecord(text: string): PreparedDraft {
	const body = sanitizeGeneratedText(extractStreamingPreview(text)).trim();
	if (!body || !text.includes("</labbook_preview>")) {
		throw new Error("The preparation model did not return a complete <labbook_preview>");
	}
	const metadataMatch = /<labbook_metadata>([\s\S]*?)<\/labbook_metadata>/i.exec(text);
	if (!metadataMatch) throw new Error("The preparation model did not return <labbook_metadata> JSON");
	let metadata: unknown;
	try {
		metadata = JSON.parse(metadataMatch[1].trim());
	} catch (error) {
		throw new Error(`The preparation model returned invalid metadata JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Value.Check(MetadataSchema, metadata)) {
		throw new Error("The preparation model returned metadata that does not match the required schema");
	}
	return { ...(metadata as PreparedMetadata), body };
}

function createRecordFromDraft(state: LabbookActivityState, draft: PreparedDraft, endedAt: string) {
	const input: LabSaveParams = {
		labId: state.start.labId,
		kind: state.start.kind,
		title: draft.title,
		startedAt: state.start.startedAt,
		endedAt,
		summary: draft.summary,
		tags: draft.tags,
		body: draft.body,
		metadata: {
			workspace: state.start.workspace,
			pi_session: state.start.sessionId,
			pi_anchor: state.start.anchorId,
		},
	};
	return createLabRecord(input);
}

type PreparedResult = {
	record: ReturnType<typeof createLabRecord>;
	preconfirmed: boolean;
};

type StreamingUiResult =
	| { kind: "confirmed"; record: ReturnType<typeof createLabRecord> }
	| { kind: "declined" }
	| { kind: "error"; message: string };

async function prepareRecord(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: LabbookActivityState,
	guidance: string,
	config: ReturnType<typeof loadConfig>,
): Promise<PreparedResult | undefined> {
	if (!ctx.model) throw new Error("No model is selected for preparing the Lab record");
	const model = ctx.model;
	const conversation = buildLabConversation(ctx.sessionManager.getBranch(), state.start.labId);
	if (!conversation.trim()) throw new Error("The active Lab branch has no discussion to save");
	const message: UserMessage = {
		role: "user",
		content: [{
			type: "text",
			text: `Lab type: ${state.start.kind}\nLab topic: ${state.start.topic}\n${guidance ? `Additional guidance: ${guidance}\n` : ""}\nConversation:\n${conversation}`,
		}],
		timestamp: Date.now(),
	};

	if (ctx.mode !== "tui") {
		const response = await ctx.modelRegistry.complete(model, { systemPrompt: EXTRACTION_PROMPT, messages: [message] }, {});
		if (response.stopReason === "error") throw new Error(response.errorMessage || "Record preparation failed");
		if (response.stopReason === "aborted") throw new Error("Record preparation was aborted");
		if (response.stopReason !== "stop") throw new Error(`Record preparation stopped with reason: ${response.stopReason}`);
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return { record: createRecordFromDraft(state, parsePreparedRecord(text), new Date().toISOString()), preconfirmed: false };
	}

	const repository = await inspectRepository(pi, config);
	validateRepositoryForPublish(config, repository);
	const result = await ctx.ui.custom<StreamingUiResult>((tui, theme, _keybindings, done) => {
		const controller = new AbortController();
		const source = new Text("Waiting for the record preview…", 1, 1);
		const header = new Text(theme.fg("accent", theme.bold("Labbook record preview (exact Markdown source)")), 1, 0);
		const target = new Text(
			`Repository: ${repository.root}\nPush remote: ${repository.pushUrls.map(sanitizeRemoteForDisplay).join(", ")}\nBranch: ${repository.branch}\nFile: preparing…`,
			1,
			0,
		);
		const footer = new Text(theme.fg("dim", "Streaming preview…  Esc cancels  ↑↓/PgUp/PgDn scroll"), 1, 0);
		const scroll = new ScrollView(source, {
			follow: "end",
			primary: true,
			overscroll: "contain",
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => theme.fg("dim", text),
			scrollbarThumbStyle: (text) => theme.fg("accent", text),
		});
		const container = new VStack([
			{ component: header, basis: "auto", shrink: 0 },
			{ component: target, basis: "auto", shrink: 0 },
			{ component: scroll, grow: 1, minSize: 6 },
			{ component: footer, basis: "auto", shrink: 0 },
		]) as VStack & { handleInput(data: string): void };

		let phase: "streaming" | "confirm" | "error" = "streaming";
		let raw = "";
		let preparedRecord: ReturnType<typeof createLabRecord> | undefined;
		let errorMessage = "";
		let disposed = false;
		let sawSuccessfulDone = false;
		const textBlocks = new Map<number, string>();

		const combinedText = () => [...textBlocks.entries()]
			.sort(([left], [right]) => left - right)
			.map(([, text]) => text)
			.join("\n");
		const refresh = () => {
			if (!disposed) tui.requestRender();
		};

		void (async () => {
			try {
				const stream = ctx.modelRegistry.streamSimple(
					model,
					{ systemPrompt: EXTRACTION_PROMPT, messages: [message] },
					{ signal: controller.signal },
				);
				for await (const event of stream) {
					if (event.type === "text_delta") {
						textBlocks.set(event.contentIndex, `${textBlocks.get(event.contentIndex) ?? ""}${event.delta}`);
						raw = combinedText();
						const preview = sanitizeGeneratedText(extractStreamingPreview(raw));
						if (preview) source.setText(preview);
						refresh();
					} else if (event.type === "text_end") {
						textBlocks.set(event.contentIndex, event.content);
						raw = combinedText();
					} else if (event.type === "done") {
						if (event.reason !== "stop") throw new Error(`Record preparation stopped with reason: ${event.reason}`);
						raw = event.message.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join("\n");
						sawSuccessfulDone = true;
					} else if (event.type === "error") {
						throw new Error(event.error.errorMessage || "Record preparation failed");
					}
				}
				if (!sawSuccessfulDone) throw new Error("Record preparation stream ended without a successful completion");
				const draft = parsePreparedRecord(raw);
				preparedRecord = createRecordFromDraft(state, draft, new Date().toISOString());
				source.setText(renderLabRecord(preparedRecord));
				target.setText(
					`Repository: ${repository.root}\nPush remote: ${repository.pushUrls.map(sanitizeRemoteForDisplay).join(", ")}\nBranch: ${repository.branch}\nFile: ${recordPathForConfig(config, preparedRecord.relativePath)}`,
				);
				footer.setText(theme.fg("dim", config.publishMode === "local-only"
					? "Create this exact local commit?  [Y/Enter] Yes  [N/Esc] No  ↑↓/PgUp/PgDn scroll"
					: "Save, commit and push this exact record?  [Y/Enter] Yes  [N/Esc] No  ↑↓/PgUp/PgDn scroll"));
				phase = "confirm";
				scroll.scrollToStart();
				refresh();
			} catch (error) {
				if (disposed) return;
				errorMessage = error instanceof Error ? error.message : String(error);
				phase = "error";
				source.setText(`Preparation failed: ${errorMessage}`);
				footer.setText(theme.fg("warning", "Press Enter or Esc to close"));
				scroll.scrollToStart();
				refresh();
			}
		})();

		container.handleInput = (data: string) => {
			if (matchesKey(data, "up")) scroll.scrollBy(-1);
			else if (matchesKey(data, "down")) scroll.scrollBy(1);
			else if (matchesKey(data, "pageUp")) scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1));
			else if (matchesKey(data, "pageDown")) scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1));
			else if (matchesKey(data, "home")) scroll.scrollToStart();
			else if (matchesKey(data, "end")) scroll.scrollToEnd();
			else if (phase === "streaming" && matchesKey(data, "escape")) {
				disposed = true;
				controller.abort();
				done({ kind: "declined" });
				return;
			} else if (phase === "confirm" && (matchesKey(data, "enter") || matchesKey(data, "y") || matchesKey(data, "shift+y"))) {
				disposed = true;
				done({ kind: "confirmed", record: preparedRecord! });
				return;
			} else if (phase === "confirm" && (matchesKey(data, "escape") || matchesKey(data, "n") || matchesKey(data, "shift+n"))) {
				disposed = true;
				done({ kind: "declined" });
				return;
			} else if (phase === "error" && (matchesKey(data, "enter") || matchesKey(data, "escape"))) {
				disposed = true;
				done({ kind: "error", message: errorMessage });
				return;
			}
			refresh();
		};
		return container;
	}, {
		overlay: true,
		overlayOptions: {
			width: "90%",
			maxHeight: "90%",
			anchor: "center",
			margin: 1,
		},
	});

	if (result.kind === "declined") return undefined;
	if (result.kind === "error") throw new Error(result.message);
	return { record: result.record, preconfirmed: true };
}

function updateStatus(ctx: ExtensionContext): void {
	const state = deriveActiveBranchState(ctx);
	ctx.ui.setStatus(
		STATUS_KEY,
		state ? ctx.ui.theme.fg("accent", `lab:${state.start.kind}:${state.status}`) : undefined,
	);
}

function removeLegacyTool(pi: ExtensionAPI): void {
	const tools = pi.getActiveTools();
	if (tools.includes(LEGACY_TOOL_NAME)) pi.setActiveTools(tools.filter((name) => name !== LEGACY_TOOL_NAME));
}

function help(ctx: ExtensionContext): void {
	ctx.ui.notify(
		[
			"/lab start [experiment|note|memory] <topic>",
			"/lab save [optional guidance]",
			"/lab cancel [optional reason]",
			"/lab status",
			"/lab config",
		].join("\n"),
		"info",
	);
}

function parseStart(args: string): { kind: LabbookKind; topic: string } | undefined {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return undefined;
	const first = words[0] as LabbookKind;
	const kind = (LABBOOK_KINDS as readonly string[]).includes(first) ? first : "note";
	const topic = (kind === first ? words.slice(1) : words).join(" ").trim();
	return topic ? { kind, topic: topic.slice(0, 200) } : undefined;
}

function appendEvent(pi: ExtensionAPI, data: Record<string, unknown>): void {
	pi.appendEntry(LABBOOK_ENTRY_TYPE, { version: LABBOOK_STATE_VERSION, ...data });
}

async function returnToAnchor(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: LabbookActivityState,
	label: string,
): Promise<boolean> {
	const leaf = ctx.sessionManager.getLeafEntry();
	if (leaf) pi.setLabel(leaf.id, label);
	const result = await ctx.navigateTree(state.start.anchorId, { summarize: false });
	if (result.cancelled) {
		ctx.ui.notify("Tree navigation was cancelled; the Lab branch remains active.", "warning");
		updateStatus(ctx);
		return false;
	}
	ctx.ui.notify("Returned to the conversation point before /lab start. The Lab branch remains in /tree.", "info");
	updateStatus(ctx);
	return true;
}

export default function piLabbook(pi: ExtensionAPI): void {
	pi.registerCommand("lab", {
		description: "Discuss and publish branch-isolated notes, memories, and experiment records",
		getArgumentCompletions: (prefix) => ["start experiment ", "start note ", "start memory ", "save", "cancel", "status", "config"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [command = "help", ...rest] = trimmed.split(/\s+/);
			const remainder = rest.join(" ").trim();

			if (command === "help" || command === "") {
				help(ctx);
				return;
			}

			if (command === "start") {
				await ctx.waitForIdle();
				if (deriveActiveBranchState(ctx)) {
					ctx.ui.notify("A Lab discussion is already active on this branch.", "warning");
					return;
				}
				const parsed = parseStart(remainder);
				if (!parsed) {
					ctx.ui.notify("Usage: /lab start [experiment|note|memory] <topic>", "warning");
					return;
				}
				try {
					loadConfig();
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				const labId = randomUUID();
				appendEvent(pi, { event: "anchor" });
				const anchor = ctx.sessionManager.getLeafEntry();
				if (!anchor) {
					ctx.ui.notify("Could not create a Lab tree anchor.", "error");
					return;
				}
				appendEvent(pi, {
					event: "start",
					labId,
					anchorId: anchor.id,
					kind: parsed.kind,
					topic: parsed.topic,
					startedAt: new Date().toISOString(),
					workspace: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId(),
				});
				removeLegacyTool(pi);
				updateStatus(ctx);
				pi.sendUserMessage(
					`开始一段独立的 Lab 讨论。类型：${parsed.kind}。主题：${parsed.topic}。请先帮助我澄清目标和已知信息，一次只推进一个清晰问题；在我执行 /lab save 前不要写入或推送任何记录。`,
				);
				return;
			}

			if (command === "save") {
				await ctx.waitForIdle();
				let state = deriveActiveBranchState(ctx);
				if (!state) {
					ctx.ui.notify("No active Lab discussion on this branch.", "warning");
					return;
				}
				if (state.status === "saved") {
					ctx.ui.notify("This Lab discussion has already been saved.", "info");
					return;
				}
				let request: LabbookSaveRequestedEvent;
				if (state.status === "save_requested" && state.latest.event === "save_requested") {
					request = state.latest;
					ctx.ui.notify("Retrying the pending Lab save request.", "info");
				} else {
					request = {
						version: LABBOOK_STATE_VERSION,
						event: "save_requested",
						labId: state.start.labId,
						requestId: randomUUID(),
						requestedAt: new Date().toISOString(),
						...(remainder ? { guidance: remainder } : {}),
					};
					pi.appendEntry(LABBOOK_ENTRY_TYPE, request);
					state = deriveActiveBranchState(ctx) ?? state;
				}

				try {
					const config = loadConfig();
					const prepared = await prepareRecord(pi, ctx, state, remainder || request.guidance || "", config);
					if (!prepared) {
						appendEvent(pi, {
							event: "save_declined",
							labId: state.start.labId,
							requestId: request.requestId,
							declinedAt: new Date().toISOString(),
						});
						ctx.ui.notify("Publication was declined; staying in the Lab branch.", "info");
						return;
					}
					const record = prepared.record;
					const result = await publishRecord(pi, ctx, config, {
						relativePath: record.relativePath,
						markdown: renderLabRecord(record),
						title: record.title,
						labId: state.start.labId,
						sessionId: state.start.sessionId,
					}, { preconfirmed: prepared.preconfirmed });
					if (result.status === "declined") {
						appendEvent(pi, {
							event: "save_declined",
							labId: state.start.labId,
							requestId: request.requestId,
							declinedAt: new Date().toISOString(),
						});
						ctx.ui.notify("Publication was declined; staying in the Lab branch.", "info");
						return;
					}
					const saved: LabbookSavedEvent = {
						version: LABBOOK_STATE_VERSION,
						event: "saved",
						labId: state.start.labId,
						requestId: request.requestId,
						relativePath: result.relativePath,
						commit: result.commit,
						pushed: result.pushed,
						savedAt: new Date().toISOString(),
					};
					pi.appendEntry(LABBOOK_ENTRY_TYPE, saved);
					const fresh = deriveActiveBranchState(ctx);
					if (fresh) {
						await returnToAnchor(pi, ctx, fresh, `lab: ${fresh.start.topic} (${saved.pushed ? "pushed" : "saved locally"})`);
					}
					if (!saved.pushed) ctx.ui.notify(`Record committed locally; push is pending.${result.pushError ? ` ${result.pushError}` : ""}`, "warning");
				} catch (error) {
					appendEvent(pi, {
						event: "save_failed",
						labId: state.start.labId,
						requestId: request.requestId,
						message: error instanceof Error ? error.message : String(error),
						failedAt: new Date().toISOString(),
					});
					ctx.ui.notify(`Save failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
					updateStatus(ctx);
				}
				return;
			}

			if (command === "cancel") {
				await ctx.waitForIdle();
				const state = deriveActiveBranchState(ctx);
				if (!state) {
					ctx.ui.notify("No active Lab discussion on this branch.", "warning");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Cancel Lab discussion?",
					"No record will be written. The discussion remains available in /tree.",
				);
				if (!confirmed) return;
				appendEvent(pi, {
					event: "cancelled",
					labId: state.start.labId,
					cancelledAt: new Date().toISOString(),
					...(remainder ? { reason: remainder } : {}),
				});
				const navigated = await returnToAnchor(pi, ctx, state, `lab: ${state.start.topic} (cancelled)`);
				if (!navigated) {
					pi.appendEntry(LABBOOK_ENTRY_TYPE, state.start);
					updateStatus(ctx);
				}
				return;
			}

			if (command === "status") {
				const state = deriveActiveBranchState(ctx);
				if (!state) {
					ctx.ui.notify("No active Lab discussion on this branch.", "info");
					return;
				}
				ctx.ui.notify(
					`Lab ${state.start.labId}\nType: ${state.start.kind}\nTopic: ${state.start.topic}\nStatus: ${state.status}\nStarted: ${state.start.startedAt}`,
					"info",
				);
				return;
			}

			if (command === "config") {
				try {
					const config = loadConfig();
					const repo = await inspectRepository(pi, config);
					ctx.ui.notify(
						`Config: ${configPath()}\nRepository: ${repo.root}\nFetch remote: ${sanitizeRemoteForDisplay(repo.remoteUrl)}\nPush remote: ${repo.pushUrls.map(sanitizeRemoteForDisplay).join(", ")}\nBranch: ${repo.branch}\nClean: ${repo.clean}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			help(ctx);
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = deriveActiveBranchState(ctx);
		if (!state) return;
		return {
			message: {
				customType: "pi-labbook-context",
				display: false,
				content: `[PI LABBOOK MODE]\nLab ID: ${state.start.labId}\nType: ${state.start.kind}\nTopic: ${state.start.topic}\nStatus: ${state.status}\n\nDiscuss this topic with the user and preserve distinctions between facts, assumptions, observations, decisions, and conclusions. Ask focused follow-up questions when important information is missing. Do not write files, commit, or push with ordinary tools. /lab save is handled directly by the extension and does not require a model-callable save tool.`,
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		removeLegacyTool(pi);
		updateStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		removeLegacyTool(pi);
		updateStatus(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));
}
