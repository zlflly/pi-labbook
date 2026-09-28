import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configPath, loadConfig } from "./config.js";
import { createLabRecord, renderLabRecord, type LabSaveParams } from "./record.js";
import { inspectRepository, publishRecord } from "./repository.js";
import {
	LABBOOK_ENTRY_TYPE,
	LABBOOK_KINDS,
	LABBOOK_STATE_VERSION,
	deriveActiveBranchState,
	type LabbookActivityState,
	type LabbookKind,
	type LabbookSavedEvent,
	type LabbookSaveRequestedEvent,
} from "./state.js";

const STATUS_KEY = "pi-labbook";
const TOOL_NAME = "labbook_save";

const SaveSchema = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 200, description: "Specific title in the user's language" }),
		summary: Type.String({ minLength: 1, maxLength: 1000, description: "Concise summary" }),
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

type SaveToolParams = {
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

function bullets(items: readonly string[]): string {
	return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None recorded";
}

function recordBody(params: SaveToolParams): string {
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

function updateStatus(ctx: ExtensionContext): void {
	const state = deriveActiveBranchState(ctx);
	if (!state) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(
		STATUS_KEY,
		ctx.ui.theme.fg("accent", `lab:${state.start.kind}:${state.status}`),
	);
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
): Promise<void> {
	const leaf = ctx.sessionManager.getLeafEntry();
	if (leaf) pi.setLabel(leaf.id, label);
	const result = await ctx.navigateTree(state.start.anchorId, { summarize: false });
	if (result.cancelled) {
		ctx.ui.notify("Tree navigation was cancelled; the Lab branch remains active.", "warning");
	} else {
		ctx.ui.notify("Returned to the conversation point before /lab start. The Lab branch remains in /tree.", "info");
	}
	updateStatus(ctx);
}

export default function piLabbook(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Save Labbook Record",
		description: "Save and publish the active Lab discussion. Call exactly once, and only after /lab save created a pending save request.",
		promptSnippet: "Finalize the active Lab discussion as a structured record",
		promptGuidelines: [
			"Use labbook_save only when a hidden Lab context says that /lab save is pending.",
			"Call labbook_save exactly once and as the only tool call in that assistant message.",
			"Distinguish observations, decisions, conclusions, and next steps; do not invent missing facts.",
		],
		parameters: SaveSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const state = deriveActiveBranchState(ctx);
			if (!state || state.status !== "save_requested" || state.latest.event !== "save_requested") {
				throw new Error("No pending /lab save request exists on the active branch");
			}
			if (signal?.aborted) throw new Error("Labbook save was aborted");
			const request = state.latest as LabbookSaveRequestedEvent;
			const params = rawParams as SaveToolParams;
			const endedAt = new Date().toISOString();
			const recordInput: LabSaveParams = {
				labId: state.start.labId,
				kind: state.start.kind,
				title: params.title,
				startedAt: state.start.startedAt,
				endedAt,
				summary: params.summary,
				tags: params.tags,
				body: recordBody(params),
				metadata: {
					workspace: state.start.workspace,
					pi_session: state.start.sessionId,
					pi_anchor: state.start.anchorId,
				},
			};
			try {
				const config = loadConfig();
				const record = createLabRecord(recordInput);
				const markdown = renderLabRecord(record);
				const result = await publishRecord(pi, ctx, config, {
					relativePath: record.relativePath,
					markdown,
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
					return {
						content: [{ type: "text" as const, text: "The user declined publication; the Lab branch remains active." }],
						details: { status: "declined", labId: state.start.labId },
						terminate: true,
					};
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
				const pushNote = result.pushed ? "and pushed to GitHub" : "as a local commit; push is pending";
				return {
					content: [{
						type: "text" as const,
						text: `Saved ${result.relativePath} in commit ${result.commit.slice(0, 12)} ${pushNote}.${result.pushError ? ` ${result.pushError}` : ""}`,
					}],
					details: { ...saved, pushError: result.pushError },
					terminate: true,
				};
			} catch (error) {
				appendEvent(pi, {
					event: "save_failed",
					labId: state.start.labId,
					requestId: request.requestId,
					message: error instanceof Error ? error.message : String(error),
					failedAt: new Date().toISOString(),
				});
				throw error;
			}
		},
	});

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
				if (!pi.getActiveTools().includes(TOOL_NAME)) {
					pi.setActiveTools([...pi.getActiveTools(), TOOL_NAME]);
				}
				updateStatus(ctx);
				pi.sendUserMessage(
					`开始一段独立的 Lab 讨论。类型：${parsed.kind}。主题：${parsed.topic}。请先帮助我澄清目标和已知信息，一次只推进一个清晰问题；在我执行 /lab save 前不要写入或推送任何记录。`,
				);
				return;
			}

			if (command === "save") {
				await ctx.waitForIdle();
				const state = deriveActiveBranchState(ctx);
				if (!state) {
					ctx.ui.notify("No active Lab discussion on this branch.", "warning");
					return;
				}
				if (state.status === "save_requested") {
					ctx.ui.notify("A Lab save is already pending.", "warning");
					return;
				}
				if (state.status === "saved") {
					ctx.ui.notify("This Lab discussion has already been saved.", "info");
					return;
				}
				const requestId = randomUUID();
				appendEvent(pi, {
					event: "save_requested",
					labId: state.start.labId,
					requestId,
					requestedAt: new Date().toISOString(),
					...(remainder ? { guidance: remainder } : {}),
				});
				pi.sendUserMessage(
					`请完成当前 Lab 记录并调用 ${TOOL_NAME}，且这一轮只调用该工具一次。忠实记录事实，不要补造信息。${remainder ? `额外要求：${remainder}` : ""}`,
				);
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
				await ctx.waitForIdle();
				const updated = deriveActiveBranchState(ctx);
				if (updated?.status === "saved" && updated.latest.event === "saved") {
					const saved = updated.latest as LabbookSavedEvent;
					await returnToAnchor(pi, ctx, updated, `lab: ${updated.start.topic} (${saved.pushed ? "pushed" : "saved locally"})`);
				} else if (updated?.status === "save_declined") {
					ctx.ui.notify("Publication was declined; staying in the Lab branch.", "info");
				} else if (updated?.status === "save_failed") {
					ctx.ui.notify("Save failed; staying in the Lab branch so you can retry.", "warning");
				} else {
					ctx.ui.notify("The model did not finish the Lab save; the branch remains active.", "warning");
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
				if (state.status !== "saved") {
					const confirmed = await ctx.ui.confirm(
						"Cancel Lab discussion?",
						"No record will be written. The discussion remains available in /tree.",
					);
					if (!confirmed) return;
				}
				appendEvent(pi, {
					event: "cancelled",
					labId: state.start.labId,
					cancelledAt: new Date().toISOString(),
					...(remainder ? { reason: remainder } : {}),
				});
				await returnToAnchor(pi, ctx, state, `lab: ${state.start.topic} (cancelled)`);
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
						`Config: ${configPath()}\nRepository: ${repo.root}\nRemote: ${repo.remoteUrl}\nBranch: ${repo.branch}\nClean: ${repo.clean}`,
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
		const savePending = state.status === "save_requested";
		return {
			message: {
				customType: "pi-labbook-context",
				display: false,
				content: `[PI LABBOOK MODE]\nLab ID: ${state.start.labId}\nType: ${state.start.kind}\nTopic: ${state.start.topic}\nStatus: ${state.status}\n\nDiscuss this topic with the user and preserve distinctions between facts, assumptions, observations, decisions, and conclusions. Ask focused follow-up questions when important information is missing. Do not write files, commit, or push with ordinary tools. ${savePending ? `A save is pending: call ${TOOL_NAME} exactly once as the only tool call.` : `Do not call ${TOOL_NAME} until /lab save is requested.`}`,
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => updateStatus(ctx));
	pi.on("session_tree", async (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", async (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));
}
