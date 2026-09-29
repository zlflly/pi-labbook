import { randomUUID } from "node:crypto";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { configPath, loadConfig } from "./config.js";
import { createLabRecord, renderLabRecord, type LabSaveParams } from "./record.js";
import { inspectRepository, publishRecord, sanitizeRemoteForDisplay } from "./repository.js";
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

const SaveSchema = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 200 }),
		summary: Type.String({ minLength: 1, maxLength: 1000 }),
		objective: Type.Optional(Type.String({ maxLength: 8000 })),
		hypothesis: Type.Optional(Type.String({ maxLength: 8000 })),
		method: Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 }),
		observations: Type.Array(Type.String({ minLength: 1, maxLength: 8000 }), { maxItems: 200 }),
		decisions: Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 }),
		conclusion: Type.String({ minLength: 1, maxLength: 12000 }),
		nextSteps: Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 }),
		artifacts: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 100 }),
		tags: Type.Array(Type.String({ minLength: 1, maxLength: 48 }), { maxItems: 32 }),
	},
	{ additionalProperties: false },
);

type SaveParams = {
	title: string;
	summary: string;
	objective?: string;
	hypothesis?: string;
	method: string[];
	observations: string[];
	decisions: string[];
	conclusion: string;
	nextSteps: string[];
	artifacts: string[];
	tags: string[];
};

const EXTRACTION_PROMPT = `You turn one Pi Lab discussion into a faithful structured record.
Use only facts present in the conversation. Never invent methods, observations, decisions, conclusions, artifacts, or next steps.
Keep observations separate from decisions and conclusions.
Write in the user's language. Preserve exact commands, paths, model names, hosts, ports, errors, and identifiers.
Return exactly one <labbook_record> tag containing valid JSON and no other text.
The JSON object must have exactly these fields:
- title: string
- summary: string
- objective?: string
- hypothesis?: string
- method: string[]
- observations: string[]
- decisions: string[]
- conclusion: string
- nextSteps: string[]
- artifacts: string[]
- tags: string[]
Use empty arrays for categories not established by the conversation.`;

function bullets(items: readonly string[]): string {
	return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None recorded";
}

function recordBody(params: SaveParams): string {
	const sections = [
		`## Summary\n\n${params.summary}`,
		`## Objective\n\n${params.objective?.trim() || "Not specified"}`,
	];
	if (params.hypothesis?.trim()) sections.push(`## Hypothesis\n\n${params.hypothesis.trim()}`);
	sections.push(
		`## Method\n\n${bullets(params.method)}`,
		`## Observations\n\n${bullets(params.observations)}`,
		`## Decisions\n\n${bullets(params.decisions)}`,
		`## Conclusion\n\n${params.conclusion}`,
		`## Next steps\n\n${bullets(params.nextSteps)}`,
		`## Artifacts\n\n${bullets(params.artifacts)}`,
	);
	return sections.join("\n\n");
}

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

export function parsePreparedRecord(text: string): SaveParams {
	const match = /<labbook_record>([\s\S]*?)<\/labbook_record>/i.exec(text);
	if (!match) throw new Error("The preparation model did not return <labbook_record> JSON");
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1].trim());
	} catch (error) {
		throw new Error(`The preparation model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Value.Check(SaveSchema, parsed)) {
		throw new Error("The preparation model returned a record that does not match the required schema");
	}
	return parsed as SaveParams;
}

async function prepareRecord(
	ctx: ExtensionCommandContext,
	state: LabbookActivityState,
	guidance: string,
): Promise<SaveParams> {
	if (!ctx.model) throw new Error("No model is selected for preparing the Lab record");
	const conversation = buildLabConversation(ctx.sessionManager.getBranch(), state.start.labId);
	if (!conversation.trim()) throw new Error("The active Lab branch has no discussion to save");
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "lab:preparing"));
	try {
		const message: UserMessage = {
			role: "user",
			content: [{
				type: "text",
				text: `Lab type: ${state.start.kind}\nLab topic: ${state.start.topic}\n${guidance ? `Additional guidance: ${guidance}\n` : ""}\nConversation:\n${conversation}`,
			}],
			timestamp: Date.now(),
		};
		const response = await ctx.modelRegistry.complete(
			ctx.model,
			{ systemPrompt: EXTRACTION_PROMPT, messages: [message] },
			{},
		);
		if (response.stopReason === "error") throw new Error(response.errorMessage || "Record preparation failed");
		if (response.stopReason === "aborted") throw new Error("Record preparation was aborted");
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return parsePreparedRecord(text);
	} finally {
		updateStatus(ctx);
	}
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
					const prepared = await prepareRecord(ctx, state, remainder || request.guidance || "");
					const endedAt = new Date().toISOString();
					const input: LabSaveParams = {
						labId: state.start.labId,
						kind: state.start.kind,
						title: prepared.title,
						startedAt: state.start.startedAt,
						endedAt,
						summary: prepared.summary,
						tags: prepared.tags,
						body: recordBody(prepared),
						metadata: {
							workspace: state.start.workspace,
							pi_session: state.start.sessionId,
							pi_anchor: state.start.anchorId,
						},
					};
					const config = loadConfig();
					const record = createLabRecord(input);
					const result = await publishRecord(pi, ctx, config, {
						relativePath: record.relativePath,
						markdown: renderLabRecord(record),
						title: record.title,
						labId: state.start.labId,
						sessionId: state.start.sessionId,
					});
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
						savedAt: endedAt,
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
