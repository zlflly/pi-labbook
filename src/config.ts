import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface LabbookConfig {
	version: 1;
	repoPath: string;
	recordsDir: string;
	remote: string;
	branch: string;
	expectedRemote: string;
	publishMode: "confirm" | "local-only";
	secretScan: boolean;
}

export const DEFAULT_CONFIG: LabbookConfig = {
	version: 1,
	repoPath: "~/Projects/labbook",
	recordsDir: "records",
	remote: "origin",
	branch: "main",
	expectedRemote: "",
	publishMode: "confirm",
	secretScan: true,
};

export function configPath(): string {
	return process.env.PI_LABBOOK_CONFIG?.trim() || join(getAgentDir(), "labbook.json");
}

export function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function safeName(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value) || value.startsWith("-")) {
		throw new Error(`${field} must contain only letters, digits, '.', '_' or '-'`);
	}
	return value;
}

function safeRecordsDir(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("recordsDir must be a non-empty string");
	const normalized = normalize(value.trim());
	if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		throw new Error("recordsDir must stay inside the repository");
	}
	if (normalized.split(/[\\/]+/).some((part) => part === ".." || part === ".git" || part === ".github")) {
		throw new Error("recordsDir contains a forbidden path component");
	}
	return normalized.replaceAll("\\", "/");
}

export function loadConfig(path = configPath()): LabbookConfig {
	if (!existsSync(path)) {
		throw new Error(`Labbook config not found: ${path}. Create it from config.example.json.`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read labbook config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Labbook config must be a JSON object");
	const input = raw as Record<string, unknown>;
	if (input.version !== 1) throw new Error("Unsupported labbook config version; expected version 1");
	const repoValue = input.repoPath ?? DEFAULT_CONFIG.repoPath;
	if (typeof repoValue !== "string" || !repoValue.trim()) throw new Error("repoPath must be a non-empty string");
	const publishMode = input.publishMode ?? DEFAULT_CONFIG.publishMode;
	if (publishMode !== "confirm" && publishMode !== "local-only") {
		throw new Error("publishMode must be 'confirm' or 'local-only'");
	}
	return {
		version: 1,
		repoPath: resolve(expandHome(repoValue.trim())),
		recordsDir: safeRecordsDir(input.recordsDir ?? DEFAULT_CONFIG.recordsDir),
		remote: safeName(input.remote ?? DEFAULT_CONFIG.remote, "remote"),
		branch: safeName(input.branch ?? DEFAULT_CONFIG.branch, "branch"),
		expectedRemote: typeof input.expectedRemote === "string" ? input.expectedRemote.trim() : "",
		publishMode,
		secretScan: input.secretScan !== false,
	};
}
