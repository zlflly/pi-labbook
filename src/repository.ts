import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LabbookConfig } from "./config.js";
import { resolveContainedPath, scanSecrets } from "./record.js";

export interface PublishInput {
	relativePath: string;
	markdown: string;
	title: string;
	labId: string;
	sessionId: string;
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

async function runGit(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	args: string[],
	timeout = 60_000,
): Promise<string> {
	const result = await pi.exec("git", ["-c", "credential.interactive=false", ...args], {
		cwd,
		timeout,
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
		if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
			throw new Error(`Refusing symlinked record directory: ${cursor}`);
		}
	}
	if (existsSync(destination) && (!lstatSync(destination).isFile() || lstatSync(destination).isSymbolicLink())) {
		throw new Error(`Record destination is not a regular file: ${destination}`);
	}
}

function recordPathForConfig(config: LabbookConfig, generatedPath: string): string {
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
): Promise<{ root: string; remoteUrl: string; branch: string; clean: boolean }> {
	if (!existsSync(config.repoPath)) throw new Error(`Labbook repository does not exist: ${config.repoPath}`);
	const root = realpathSync(config.repoPath);
	const top = realpathSync(await runGit(pi, root, ["rev-parse", "--show-toplevel"]));
	if (top !== root) throw new Error(`Configured repoPath is not the Git repository root: ${root}`);
	const branch = await runGit(pi, root, ["branch", "--show-current"]);
	const remoteUrl = await runGit(pi, root, ["remote", "get-url", config.remote]);
	const status = await runGit(pi, root, ["status", "--porcelain=v1", "--untracked-files=all"]);
	return { root, remoteUrl, branch, clean: status.length === 0 };
}

export async function publishRecord(
	pi: Pick<ExtensionAPI, "exec">,
	ctx: ExtensionContext,
	config: LabbookConfig,
	input: PublishInput,
): Promise<PublishResult> {
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

	const initial = await inspectRepository(pi, config);
	if (!initial.clean) throw new Error(`Labbook repository has uncommitted changes: ${initial.root}`);
	if (initial.branch !== config.branch) {
		throw new Error(`Labbook repository is on branch '${initial.branch}', expected '${config.branch}'`);
	}
	if (config.expectedRemote && normalizeRemote(initial.remoteUrl) !== normalizeRemote(config.expectedRemote)) {
		throw new Error(`Remote mismatch: expected ${normalizeRemote(config.expectedRemote)}, got ${normalizeRemote(initial.remoteUrl)}`);
	}

	const lock = acquireLock(initial.root);
	try {
		await runGit(pi, initial.root, ["pull", "--ff-only", config.remote, config.branch], 120_000);
		const afterPull = await inspectRepository(pi, config);
		if (!afterPull.clean || afterPull.branch !== config.branch) {
			throw new Error("Repository changed during synchronization; refusing to publish");
		}

		const relativePath = recordPathForConfig(config, input.relativePath);
		const destination = resolveContainedPath(initial.root, relativePath);
		mkdirSync(dirname(destination), { recursive: true });
		ensureNoSymlinkPath(initial.root, destination);
		const parentReal = realpathSync(dirname(destination));
		resolveContainedPath(initial.root, relative(initial.root, parentReal));
		if (existsSync(destination)) throw new Error(`Record already exists: ${relativePath}`);

		if (config.publishMode === "confirm") {
			const previewLimit = 7_000;
			const preview = input.markdown.length > previewLimit
				? `${input.markdown.slice(0, previewLimit)}\n\n[preview truncated]`
				: input.markdown;
			const confirmed = await ctx.ui.confirm(
				"Publish labbook record?",
				`Repository: ${initial.root}\nRemote: ${normalizeRemote(initial.remoteUrl)}\nBranch: ${config.branch}\nFile: ${relativePath}\n\n${preview}`,
			);
			if (!confirmed) return { status: "declined" };
		}

		const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
		let committed = false;
		try {
			writeFileSync(temp, input.markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
			renameSync(temp, destination);
			await runGit(pi, initial.root, ["add", "--", relativePath]);
			const staged = (await runGit(pi, initial.root, ["diff", "--cached", "--name-only", "--"])).split("\n").filter(Boolean);
			if (staged.length !== 1 || staged[0] !== relativePath) {
				throw new Error(`Unexpected staged paths: ${staged.join(", ") || "none"}`);
			}
			const message = `labbook: ${input.title}`;
			await runGit(pi, initial.root, [
				"commit",
				"-m",
				message,
				"-m",
				`Pi-Labbook-ID: ${input.labId}\nPi-Session-ID: ${input.sessionId}`,
			]);
			committed = true;
			const commit = await runGit(pi, initial.root, ["rev-parse", "HEAD"]);

			if (config.publishMode === "local-only") {
				return { status: "saved", relativePath, commit, pushed: false };
			}
			try {
				await runGit(pi, initial.root, ["push", config.remote, `HEAD:refs/heads/${config.branch}`], 120_000);
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
		unlinkSync(lock.path);
	}
}
