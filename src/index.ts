import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { configPath, loadConfig } from "./config.js";
import { createLabRecord, type LabSaveParams } from "./record.js";
import {
	inspectRepository,
	publishRecord,
	recordPathForConfig,
	sanitizeRemoteForDisplay,
	validateRepositoryForPublish,
} from "./repository.js";
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

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function sanitizeGeneratedText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\u009D[\s\S]*?(?:\u009C|\u0007)/g, "")
		.replace(/\u009B[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
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

export interface VisibleRecordDraft {
	title: string;
	summary: string;
	body: string;
	tags: string[];
}

function stripOuterMarkdownFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
	return match ? match[1].trim() : trimmed;
}

export function parseVisibleRecord(text: string, state: LabbookActivityState): VisibleRecordDraft {
	const cleaned = stripOuterMarkdownFence(sanitizeGeneratedText(text));
	if (!cleaned) throw new Error("The model returned an empty Lab record");
	const lines = cleaned.split("\n");
	const firstContent = lines.findIndex((line) => line.trim().length > 0);
	const heading = firstContent >= 0 ? /^#\s+(.+?)\s*$/.exec(lines[firstContent]) : null;
	const title = heading?.[1]?.trim() || state.start.topic;
	if (heading) lines.splice(firstContent, 1);
	const body = lines.join("\n").trim();
	if (!body) throw new Error("The model returned a title without record content");
	const summaryMatch = /(?:^|\n)##\s*(?:Summary|摘要)\s*\n+([\s\S]*?)(?=\n##\s|$)/i.exec(body);
	const fallbackSummary = body
		.split(/\n\s*\n/)
		.map((part) => part.replace(/^#+\s+.*$/gm, "").trim())
		.find(Boolean);
	const summary = (summaryMatch?.[1]?.trim() || fallbackSummary || title).slice(0, 1000);
	return { title, summary, body, tags: [state.start.kind] };
}

export function findAssistantRecordAfterRequest(
	branch: readonly SessionEntry[],
	requestId: string,
): string | undefined {
	let afterRequest = false;
	for (const entry of branch) {
		const event = parseLabbookEntry(entry);
		if (event?.event === "save_requested" && event.requestId === requestId) {
			afterRequest = true;
			continue;
		}
		if (!afterRequest || entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason !== "stop") continue;
		const text = messageText(entry.message.content).trim();
		if (text) return text;
	}
	return undefined;
}

function recordInstructions(kind: LabbookKind): string {
	if (kind === "experiment") {
		return "Use suitable sections from: Summary, Objective, Hypothesis (only if discussed), Environment, Method, Observations, Decisions, Conclusion, Next steps, Artifacts.";
	}
	if (kind === "memory") {
		return "Use suitable sections from: Statement, When to apply, Evidence, Exceptions, Source, Last verified.";
	}
	return "Use suitable sections from: Summary, Context, Key points, Details, Decisions, Open questions, References.";
}

function saveGenerationPrompt(state: LabbookActivityState, guidance: string): string {
	return `请把当前 Lab 讨论整理成最终 Markdown 记录，并直接作为本轮正常回复输出，让我在当前对话中实时查看生成过程。

要求：
- 只输出 Markdown，不调用任何工具，不解释生成过程，也不要使用代码围栏。
- 第一行必须是“# 具体标题”。
- 忠实使用当前对话中的信息，不得补造方法、观察、决策、结论、产物或后续行动。
- 区分事实、假设、观察、决策和结论。
- 使用用户的语言，准确保留命令、路径、模型名、主机、端口、错误和标识符。
- ${recordInstructions(state.start.kind)}
- 没有可靠信息的可选章节直接省略，不要填写虚构占位内容。
${guidance ? `- 额外要求：${guidance}` : ""}`;
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
	const settledWaiters = new Set<(settled: boolean) => void>();
	let saveInProgress = false;
	let saveGenerationRequestId: string | undefined;

	function waitForNextAgentSettled(timeoutMs = 180_000): Promise<boolean> {
		return new Promise((resolvePromise) => {
			let finished = false;
			let timer: NodeJS.Timeout;
			const finish = (settled: boolean) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				settledWaiters.delete(finish);
				resolvePromise(settled);
			};
			timer = setTimeout(() => finish(false), timeoutMs);
			settledWaiters.add(finish);
		});
	}

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
				if (!ctx.hasUI) {
					ctx.ui.notify("/lab save requires an interactive UI for explicit publication confirmation.", "error");
					return;
				}
				if (!ctx.model) {
					ctx.ui.notify("No model is selected for generating the Lab record.", "error");
					return;
				}
				if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
					ctx.ui.notify(`No authentication is configured for ${ctx.model.provider}/${ctx.model.id}.`, "error");
					return;
				}
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (!auth.ok) {
					ctx.ui.notify(auth.error, "error");
					return;
				}
				if (saveInProgress) {
					ctx.ui.notify("A Lab save is already running.", "warning");
					return;
				}
				saveInProgress = true;
				try {
				await ctx.waitForIdle();
				if (ctx.hasPendingMessages()) {
					ctx.ui.notify("Finish or clear queued messages before /lab save.", "warning");
					return;
				}
				let state = deriveActiveBranchState(ctx);
				if (!state) {
					ctx.ui.notify("No active Lab discussion on this branch.", "warning");
					return;
				}
				if (state.status === "saved") {
					ctx.ui.notify("This Lab discussion has already been saved.", "info");
					return;
				}

				if (state.status === "save_requested" && state.latest.event === "save_requested") {
					appendEvent(pi, {
						event: "save_failed",
						labId: state.start.labId,
						requestId: state.latest.requestId,
						message: "Superseded by a fresh /lab save attempt",
						failedAt: new Date().toISOString(),
					});
					ctx.ui.notify("Starting a fresh attempt for the pending Lab save.", "info");
				}
				const request: LabbookSaveRequestedEvent = {
					version: LABBOOK_STATE_VERSION,
					event: "save_requested",
					labId: state.start.labId,
					requestId: randomUUID(),
					requestedAt: new Date().toISOString(),
					...(remainder ? { guidance: remainder } : {}),
				};
				pi.appendEntry(LABBOOK_ENTRY_TYPE, request);
				state = deriveActiveBranchState(ctx) ?? state;

				let publicationCompleted = false;
				try {
					const config = loadConfig();
					const repository = await inspectRepository(pi, config);
					validateRepositoryForPublish(config, repository);
					const settled = waitForNextAgentSettled();
					saveGenerationRequestId = request.requestId;
					pi.sendUserMessage(saveGenerationPrompt(state, remainder || request.guidance || ""));
					const didSettle = await settled;
					if (!didSettle) {
						ctx.abort();
						throw new Error("The streamed save turn did not settle before the extension timeout");
					}
					await ctx.waitForIdle();
					const visibleMarkdown = findAssistantRecordAfterRequest(ctx.sessionManager.getBranch(), request.requestId);
					if (!visibleMarkdown) throw new Error("The model did not produce a completed Markdown record after /lab save");
					const visibleSource = `${sanitizeGeneratedText(visibleMarkdown).trim()}\n`;
					const draft = parseVisibleRecord(visibleSource, state);
					const endedAt = new Date().toISOString();
					const input: LabSaveParams = {
						labId: state.start.labId,
						kind: state.start.kind,
						title: draft.title,
						startedAt: state.start.startedAt,
						endedAt,
						summary: draft.summary,
						tags: draft.tags,
						body: draft.body,
					};
					const record = createLabRecord(input);
					const relativePath = recordPathForConfig(config, record.relativePath);
					const confirmed = await ctx.ui.confirm(
						config.publishMode === "local-only" ? "Create Labbook commit?" : "Publish Labbook record?",
						`The Markdown record streamed above will be saved.\n\nRepository: ${repository.root}\nPush remote: ${repository.pushUrls.map(sanitizeRemoteForDisplay).join(", ")}\nBranch: ${repository.branch}\nFile: ${relativePath}`,
					);
					if (!confirmed) {
						appendEvent(pi, {
							event: "save_declined",
							labId: state.start.labId,
							requestId: request.requestId,
							declinedAt: new Date().toISOString(),
						});
						ctx.ui.notify("Publication was declined; staying in the Lab branch.", "info");
						return;
					}

					const result = await publishRecord(pi, ctx, config, {
						relativePath: record.relativePath,
						markdown: visibleSource,
						title: record.title,
						labId: state.start.labId,
						sessionId: state.start.sessionId,
					}, { preconfirmed: true });
					if (result.status === "declined") return;
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
					publicationCompleted = true;
					const fresh = deriveActiveBranchState(ctx);
					if (fresh) {
						await returnToAnchor(pi, ctx, fresh, `lab: ${fresh.start.topic} (${saved.pushed ? "pushed" : "saved locally"})`);
					}
					if (!saved.pushed) ctx.ui.notify(`Record committed locally; push is pending.${result.pushError ? ` ${result.pushError}` : ""}`, "warning");
				} catch (error) {
					if (publicationCompleted) {
						ctx.ui.notify(
							`Record was published, but returning to the Tree anchor failed: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					} else {
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
				}
				} finally {
					saveInProgress = false;
					saveGenerationRequestId = undefined;
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

	pi.on("tool_call", async (event) => {
		if (!saveGenerationRequestId) return;
		return {
			block: true,
			reason: `Lab save ${saveGenerationRequestId} is generating a review-only Markdown response. Tool calls are disabled until the user confirms publication.`,
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = deriveActiveBranchState(ctx);
		if (!state) return;
		const savePending = state.status === "save_requested";
		return {
			message: {
				customType: "pi-labbook-context",
				display: false,
				content: `[PI LABBOOK MODE]\nLab ID: ${state.start.labId}\nType: ${state.start.kind}\nTopic: ${state.start.topic}\nStatus: ${state.status}\n\n${savePending ? `The user invoked /lab save. Output the final Labbook Markdown as the normal assistant response so it streams in the current conversation. Do not call tools. Begin with one H1 title and follow the requested record structure.` : `Discuss this topic with the user and preserve distinctions between facts, assumptions, observations, decisions, and conclusions. Ask focused follow-up questions when important information is missing. Do not write files, commit, or push with ordinary tools. /lab save is handled directly by the extension.`}`,
			},
		};
	});

	pi.on("agent_settled", async () => {
		for (const resolveWaiter of [...settledWaiters]) resolveWaiter(true);
	});
	pi.on("session_start", async (_event, ctx) => {
		removeLegacyTool(pi);
		updateStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		removeLegacyTool(pi);
		updateStatus(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		for (const resolveWaiter of [...settledWaiters]) resolveWaiter(false);
		saveInProgress = false;
		saveGenerationRequestId = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
