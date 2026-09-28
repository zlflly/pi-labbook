import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LabbookConfig } from "../src/config.js";
import { publishRecord } from "../src/repository.js";

const execFileAsync = promisify(execFile);

async function command(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd });
	return result.stdout.trim();
}

async function fixture(): Promise<{ root: string; remote: string; config: LabbookConfig }> {
	const root = mkdtempSync(join(tmpdir(), "pi-labbook-test-"));
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");
	await execFileAsync("git", ["init", "--bare", remote]);
	await execFileAsync("git", ["clone", remote, repo]);
	await command(repo, ["config", "user.name", "Pi Labbook Test"]);
	await command(repo, ["config", "user.email", "test@example.invalid"]);
	writeFileSync(join(repo, "README.md"), "# Test Labbook\n");
	await command(repo, ["add", "README.md"]);
	await command(repo, ["commit", "-m", "init"]);
	await command(repo, ["branch", "-M", "main"]);
	await command(repo, ["push", "-u", "origin", "main"]);
	return {
		root: repo,
		remote,
		config: {
			version: 1,
			repoPath: repo,
			recordsDir: "records",
			remote: "origin",
			branch: "main",
			expectedRemote: remote,
			publishMode: "confirm",
			secretScan: true,
		},
	};
}

const pi = {
	async exec(executable: string, args: string[], options?: { cwd?: string; timeout?: number }) {
		try {
			const result = await execFileAsync(executable, args, {
				cwd: options?.cwd,
				timeout: options?.timeout,
			});
			return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
		} catch (error) {
			const failure = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
			return {
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? failure.message,
				code: typeof failure.code === "number" ? failure.code : 1,
				killed: failure.killed ?? false,
			};
		}
	},
} as Pick<ExtensionAPI, "exec">;

const approvingContext = {
	hasUI: true,
	ui: { confirm: async () => true },
} as unknown as ExtensionContext;

test("publishes exactly one generated record and pushes it", async () => {
	const { root, remote, config } = await fixture();
	const relativePath = "records/experiments/2026/09/vpn-test--12345678.md";
	const result = await publishRecord(pi, approvingContext, config, {
		relativePath,
		markdown: "---\ntitle: \"VPN test\"\n---\n\n# VPN test\n\nWorked.\n",
		title: "VPN test",
		labId: "12345678-abcd",
		sessionId: "session-1",
	});
	assert.equal(result.status, "saved");
	if (result.status !== "saved") return;
	assert.equal(result.pushed, true);
	assert.equal(readFileSync(join(root, relativePath), "utf8").includes("Worked."), true);
	assert.match(await command(remote, ["log", "main", "-1", "--format=%B"]), /Pi-Labbook-ID: 12345678-abcd/);
	assert.equal(await command(root, ["status", "--porcelain"]), "");
});

test("refuses to touch a dirty repository", async () => {
	const { root, config } = await fixture();
	writeFileSync(join(root, "dirty.txt"), "do not touch\n");
	await assert.rejects(
		publishRecord(pi, approvingContext, config, {
			relativePath: "records/notes/2026/09/test--abcdef12.md",
			markdown: "# Test\n",
			title: "Test",
			labId: "abcdef12-abcd",
			sessionId: "session-2",
		}),
		/uncommitted changes/,
	);
	assert.equal(readFileSync(join(root, "dirty.txt"), "utf8"), "do not touch\n");
});
