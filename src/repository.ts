import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { LabbookConfig } from "./config.js";
import { resolveContainedPath, scanSecrets } from "./record.js";

export interface PublishInput {
	relativePath: string;
	markdown: string;
	title: string;
	labId: string;
	sessionId: string;
}

export interface PublishOptions {
	signal?: AbortSignal;
	/** The TUI already displayed the exact final Markdown and received explicit Yes/No confirmation. */
	preconfirmed?: boolean;
}

export type PublishResult =
	| { status: "declined" }
	| { status: "saved"; relativePath: string; commit: string; pushed: boolean; pushError?: string };

function redact(text: string): string {
	return text
		.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[REDACTED]@")
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]");
}

function normalizeRemote(value: string): string {
	return value
		.trim()
		.replace(/^git@github\.com:/, "https://github.com/")
		.replace(/\.git$/, "")
		.replace(/\/$/, "");
}

export function sanitizeRemoteForDisplay(value: string): string {
	return redact(value).replace(/([?&](?:token|access_token|auth)=)[^&\s]+/gi, "$1[REDACTED]");
}

function assertRemoteHasNoEmbeddedCredentials(value: string): void {
	if (/^https?:\/\//i.test(value)) {
		const parsed = new URL(value);
		if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some((key) => /token|auth|key/i.test(key))) {
			throw new Error("Credential-bearing Git remote URLs are not allowed; use gh auth, a credential helper, or SSH agent");
		}
	}
	if (/\b(?:gh[pousr]_|github_pat_)/i.test(value)) {
		throw new Error("Credential-bearing Git remote URLs are not allowed");
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Labbook publication was aborted");
}

async function runGit(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	args: string[],
	timeout = 60_000,
	signal?: AbortSignal,
): Promise<string> {
	const result = await pi.exec("git", ["-c", "credential.interactive=false", "-c", "core.quotePath=false", ...args], {
		cwd,
		timeout,
		signal,
	});
	if (result.code !== 0) {
		const detail = redact((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
		throw new Error(detail);
	}
	return result.stdout.trim();
}

function ensureNoSymlinkPath(root: string, destination: string): void {
	const rel = relative(root, destination);
	let cursor = root;
	for (const part of rel.split(sep).slice(0, -1)) {
		cursor = resolve(cursor, part);
		if (!existsSync(cursor)) break;
		if (lstatSync(cursor).isSymbolicLink()) {
			throw new Error(`Refusing symlinked record directory: ${cursor}`);
		}
	}
	if (existsSync(destination) && (!lstatSync(destination).isFile() || lstatSync(destination).isSymbolicLink())) {
		throw new Error(`Record destination is not a regular file: ${destination}`);
	}
}

export function recordPathForConfig(config: LabbookConfig, generatedPath: string): string {
	const suffix = generatedPath.startsWith("records/") ? generatedPath.slice("records/".length) : generatedPath;
	return `${config.recordsDir.replace(/\/$/, "")}/${suffix}`;
}

function acquireLock(repoRoot: string): { path: string; fd: number } {
	const lockPath = resolve(repoRoot, ".git", "pi-labbook.lock");
	try {
		const fd = openSync(lockPath, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
		return { path: lockPath, fd };
	} catch (error) {
		throw new Error(`Labbook repository is busy (${lockPath}). Remove a stale lock only after confirming no Pi save is running.`);
	}
}

export async function inspectRepository(
	pi: Pick<ExtensionAPI, "exec">,
	config: LabbookConfig,
	signal?: AbortSignal,
): Promise<{ root: string; remoteUrl: string; pushUrls: string[]; branch: string; clean: boolean }> {
	throwIfAborted(signal);
	if (!existsSync(config.repoPath)) throw new Error(`Labbook repository does not exist: ${config.repoPath}`);
	const root = realpathSync(config.repoPath);
	const top = realpathSync(await runGit(pi, root, ["rev-parse", "--show-toplevel"], 60_000, signal));
	if (top !== root) throw new Error(`Configured repoPath is not the Git repository root: ${root}`);
	const branch = await runGit(pi, root, ["branch", "--show-current"], 60_000, signal);
	const remoteUrl = await runGit(pi, root, ["remote", "get-url", config.remote], 60_000, signal);
	const pushUrls = (await runGit(pi, root, ["remote", "get-url", "--push", "--all", config.remote], 60_000, signal))
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean);
	assertRemoteHasNoEmbeddedCredentials(remoteUrl);
	for (const pushUrl of pushUrls) assertRemoteHasNoEmbeddedCredentials(pushUrl);
	const status = await runGit(pi, root, ["status", "--porcelain=v1", "--untracked-files=all"], 60_000, signal);
	return { root, remoteUrl, pushUrls, branch, clean: status.length === 0 };
}

function assertExpectedRemote(
	config: LabbookConfig,
	repository: { remoteUrl: string; pushUrls: string[] },
): void {
	if (config.publishMode !== "local-only" && !config.expectedRemote) {
		throw new Error("expectedRemote is required when GitHub publishing is enabled");
	}
	if (!config.expectedRemote) return;
	const expected = normalizeRemote(config.expectedRemote);
	const actual = [repository.remoteUrl, ...repository.pushUrls];
	for (const url of actual) {
		if (normalizeRemote(url) !== expected) {
			throw new Error(
				`Remote mismatch: expected ${sanitizeRemoteForDisplay(config.expectedRemote)}, got ${sanitizeRemoteForDisplay(url)}`,
			);
		}
	}
}

export function validateRepositoryForPublish(
	config: LabbookConfig,
	repository: { root: string; remoteUrl: string; pushUrls: string[]; branch: string; clean: boolean },
): void {
	if (!repository.clean) throw new Error(`Labbook repository has uncommitted changes: ${repository.root}`);
	if (repository.branch !== config.branch) {
		throw new Error(`Labbook repository is on branch '${repository.branch}', expected '${config.branch}'`);
	}
	assertExpectedRemote(config, repository);
}

async function publishRecordUnlocked(
	pi: Pick<ExtensionAPI, "exec">,
	ctx: ExtensionContext,
	config: LabbookConfig,
	input: PublishInput,
	options: PublishOptions,
): Promise<PublishResult> {
	const signal = options.signal;
	if (!ctx.hasUI && config.publishMode === "confirm") {
		throw new Error("Publishing requires an interactive confirmation UI");
	}
	if (config.secretScan) {
		const findings = scanSecrets(input.markdown);
		if (findings.length > 0) {
			const locations = findings.map((item) => `${item.message} at ${item.line}:${item.column}`).join("; ");
			throw new Error(`Secret scan blocked publication: ${locations}`);
		}
	}

	throwIfAborted(signal);
	const initial = await inspectRepository(pi, config, signal);
	validateRepositoryForPublish(config, initial);

	const lock = acquireLock(initial.root);
	try {
		await runGit(pi, initial.root, ["pull", "--ff-only", config.remote, config.branch], 120_000, signal);
		const afterPull = await inspectRepository(pi, config, signal);
		validateRepositoryForPublish(config, afterPull);
		throwIfAborted(signal);

		const relativePath = recordPathForConfig(config, input.relativePath);
		const destination = resolveContainedPath(initial.root, relativePath);
		ensureNoSymlinkPath(initial.root, destination);
		mkdirSync(dirname(destination), { recursive: true });
		ensureNoSymlinkPath(initial.root, destination);
		const parentReal = realpathSync(dirname(destination));
		resolveContainedPath(initial.root, relative(initial.root, parentReal));
		if (existsSync(destination)) throw new Error(`Record already exists: ${relativePath}`);

		if (config.publishMode === "confirm" && !options.preconfirmed) {
			const previewLimit = 7_000;
			const preview = input.markdown.length > previewLimit
				? `${input.markdown.slice(0, previewLimit)}\n\n[preview truncated]`
				: input.markdown;
			const confirmed = await ctx.ui.confirm(
				"Publish labbook record?",
				`Repository: ${initial.root}\nPush remote: ${afterPull.pushUrls.map(sanitizeRemoteForDisplay).join(", ")}\nBranch: ${config.branch}\nFile: ${relativePath}\n\n${preview}`,
				{ signal },
			);
			if (!confirmed) return { status: "declined" };
		}
		throwIfAborted(signal);

		const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
		let committed = false;
		try {
			writeFileSync(temp, input.markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
			throwIfAborted(signal);
			renameSync(temp, destination);
			await runGit(pi, initial.root, ["add", "--", relativePath], 60_000, signal);
			const staged = (await runGit(pi, initial.root, ["diff", "--cached", "--name-only", "-z", "--"], 60_000, signal)).split("\0").filter(Boolean);
			if (staged.length !== 1 || staged[0] !== relativePath) {
				throw new Error(`Unexpected staged paths: ${staged.join(", ") || "none"}`);
			}
			const message = `labbook: ${input.title}`;
			throwIfAborted(signal);
			await runGit(pi, initial.root, [
				"commit",
				"-m",
				message,
				"-m",
				`Pi-Labbook-ID: ${input.labId}\nPi-Session-ID: ${input.sessionId}`,
			], 60_000, signal);
			committed = true;
			const commit = await runGit(pi, initial.root, ["rev-parse", "HEAD"]);

			if (config.publishMode === "local-only") {
				return { status: "saved", relativePath, commit, pushed: false };
			}
			if (signal?.aborted) {
				return { status: "saved", relativePath, commit, pushed: false, pushError: "Publication was aborted after the local commit" };
			}
			try {
				const beforePush = await inspectRepository(pi, config, signal);
				assertExpectedRemote(config, beforePush);
				await runGit(pi, initial.root, ["push", config.remote, `HEAD:refs/heads/${config.branch}`], 120_000, signal);
				return { status: "saved", relativePath, commit, pushed: true };
			} catch (error) {
				return {
					status: "saved",
					relativePath,
					commit,
					pushed: false,
					pushError: error instanceof Error ? redact(error.message) : "push failed",
				};
			}
		} catch (error) {
			if (existsSync(temp)) unlinkSync(temp);
			if (!committed) {
				await pi.exec("git", ["reset", "--quiet", "HEAD", "--", relativePath], { cwd: initial.root }).catch(() => undefined);
				if (existsSync(destination)) rmSync(destination, { force: true });
			}
			throw error;
		}
	} finally {
		closeSync(lock.fd);
		if (existsSync(lock.path)) unlinkSync(lock.path);
	}
}

export async function publishRecord(
	pi: Pick<ExtensionAPI, "exec">,
	ctx: ExtensionContext,
	config: LabbookConfig,
	input: PublishInput,
	options: PublishOptions = {},
): Promise<PublishResult> {
	return withFileMutationQueue(config.repoPath, () => publishRecordUnlocked(pi, ctx, config, input, options));
}
