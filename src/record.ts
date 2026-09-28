import * as path from "node:path";

/** Limits are measured in Unicode code points unless a property says otherwise. */
export const LAB_RECORD_LIMITS = Object.freeze({
  labId: 128,
  kind: 48,
  title: 200,
  summary: 1_000,
  body: 200_000,
  tag: 48,
  tags: 32,
  slugCodePoints: 64,
  slugBytes: 120,
} as const);

export const RECORD_LIMITS = LAB_RECORD_LIMITS;

export const LAB_RECORD_KINDS = ["experiment", "note", "memory"] as const;

/** Record kinds mirror the activity kinds persisted by the labbook state. */
export type LabRecordKind = (typeof LAB_RECORD_KINDS)[number];

export type LabMetadataValue = string | number | boolean | null;
export type LabMetadata = Readonly<Record<string, LabMetadataValue>>;

/** Input accepted by createLabRecord. `body` is preferred; `content` is an alias. */
export interface LabSaveParams {
  labId: string;
  kind: LabRecordKind;
  title: string;
  startedAt: string | Date;
  endedAt?: string | Date | null;
  summary?: string;
  tags?: readonly string[];
  body?: string;
  content?: string;
  metadata?: LabMetadata;
}

export interface LabRecordFrontmatter {
  schema: "pi-labbook/v1";
  labId: string;
  kind: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  summary: string;
  tags: readonly string[];
  metadata: LabMetadata;
}

export interface LabRecord extends LabRecordFrontmatter {
  body: string;
  /** Always slash-separated and relative to the repository. */
  relativePath: string;
}

export type SecretFindingType =
  | "private-key"
  | "github-token"
  | "aws-access-key"
  | "aws-secret-key"
  | "credential-assignment";

export interface SecretFinding {
  /** `type` and `kind` intentionally carry the same stable machine-readable value. */
  type: SecretFindingType;
  kind: SecretFindingType;
  index: number;
  end: number;
  line: number;
  column: number;
  message: string;
  /** A redacted description, never the secret itself. */
  preview: string;
}

const KIND_DIRECTORIES: Readonly<Record<string, string>> = Object.freeze({
  session: "sessions",
  sessions: "sessions",
  experiment: "experiments",
  experiments: "experiments",
  decision: "decisions",
  decisions: "decisions",
  incident: "incidents",
  incidents: "incidents",
  note: "notes",
  notes: "notes",
  memory: "memories",
  memories: "memories",
  observation: "observations",
  observations: "observations",
  research: "research",
  other: "other",
});

export { KIND_DIRECTORIES };

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Truncate without splitting a surrogate pair. */
export function truncateUnicode(value: string, maxCodePoints: number): string {
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 0) {
    throw new RangeError("maxCodePoints must be a non-negative integer");
  }
  return Array.from(value).slice(0, maxCodePoints).join("");
}

/** Truncate on both Unicode-code-point and UTF-8 boundaries. */
export function truncateUtf8(
  value: string,
  maxBytes: number,
  maxCodePoints = Number.POSITIVE_INFINITY,
): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxCodePoints < 0) {
    throw new RangeError("length limits must be non-negative");
  }
  let result = "";
  let bytes = 0;
  let count = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes || count >= maxCodePoints) break;
    result += character;
    bytes += characterBytes;
    count += 1;
  }
  return result;
}

function rejectOversize(name: string, value: string, maximum: number): void {
  if (codePointLength(value) > maximum) {
    throw new RangeError(`${name} must be at most ${maximum} Unicode characters`);
  }
}

function normalizeMultiline(value: string, name: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  rejectOversize(name, normalized, maximum);
  return normalized;
}

/** Normalize a human-facing, single-line value and enforce its Unicode length. */
export function normalizeSingleLine(
  value: string,
  maximum: number = LAB_RECORD_LIMITS.title,
  name = "value",
): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
  rejectOversize(name, normalized, maximum);
  return normalized;
}

export function normalizeTitle(title: string): string {
  const normalized = normalizeSingleLine(title, LAB_RECORD_LIMITS.title, "title");
  if (!normalized) throw new TypeError("title must not be empty");
  return normalized;
}

export function normalizeTags(tags: readonly string[] = []): string[] {
  if (!Array.isArray(tags)) throw new TypeError("tags must be an array");
  if (tags.length > LAB_RECORD_LIMITS.tags) {
    throw new RangeError(`tags must contain at most ${LAB_RECORD_LIMITS.tags} values`);
  }
  const unique = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeSingleLine(tag, LAB_RECORD_LIMITS.tag, "tag");
    if (normalized) unique.add(normalized);
  }
  // Default string order is defined in terms of UTF-16 code units and does not
  // vary with the machine's locale or ICU version.
  return [...unique].sort();
}

/**
 * Make a filename component while retaining letters from every script. Slashes,
 * dot segments, punctuation, and control characters can never survive.
 */
export function slugify(title: string): string {
  const normalized = normalizeTitle(title).normalize("NFKC").toLowerCase();
  const slug = normalized
    .replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  const bounded = truncateUtf8(
    slug,
    LAB_RECORD_LIMITS.slugBytes,
    LAB_RECORD_LIMITS.slugCodePoints,
  ).replace(/-+$/g, "");
  return bounded || "untitled";
}

export const slugifyTitle = slugify;

export function normalizeKind(kind: string): string {
  const normalized = normalizeSingleLine(kind, LAB_RECORD_LIMITS.kind, "kind")
    .normalize("NFKC")
    .toLowerCase();
  if (!normalized) throw new TypeError("kind must not be empty");
  const safe = normalized
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe || safe === "." || safe === "..") {
    throw new TypeError("kind must contain a letter or number");
  }
  return safe;
}

export function kindDirectory(kind: string): string {
  const normalized = normalizeKind(kind);
  return KIND_DIRECTORIES[normalized] ?? normalized;
}

export function labId8(labId: string): string {
  const normalized = normalizeSingleLine(labId, LAB_RECORD_LIMITS.labId, "labId").normalize(
    "NFKC",
  );
  if (!normalized) throw new TypeError("labId must not be empty");
  // Restrict rather than merely replacing unsafe characters: two distinct IDs
  // must not silently collapse to the same filename, and traversal cannot pass.
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new TypeError("labId may contain only ASCII letters, digits, '_' and '-'");
  }
  return normalized.slice(0, 8);
}

export const shortLabId = labId8;

function parseInstant(value: string | Date, name: string): Date {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    if (Number.isNaN(copy.getTime())) throw new TypeError(`${name} is not a valid date`);
    return copy;
  }
  if (typeof value !== "string") throw new TypeError(`${name} must be a Date or ISO date string`);
  const trimmed = value.trim();
  // A calendar-only start date means midnight in Asia/Shanghai, not host-local time.
  const source = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00+08:00`
    : trimmed;
  // Reject timezone-less timestamps because their meaning otherwise depends on TZ.
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(source) ||
    !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(source)
  ) {
    throw new TypeError(`${name} must be an ISO date with a timezone`);
  }
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${name} is not a valid date`);
  return parsed;
}

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface CalendarDateParts {
  year: string;
  month: string;
  day: string;
}

export function shanghaiDateParts(startedAt: string | Date): CalendarDateParts {
  const parts = shanghaiDateFormatter.formatToParts(parseInstant(startedAt, "startedAt"));
  const find = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`Intl did not return a ${type}`);
    return value;
  };
  return { year: find("year"), month: find("month"), day: find("day") };
}

export interface RecordPathInput {
  kind: string;
  title: string;
  labId: string;
  startedAt: string | Date;
}

export function generateRecordPath(input: RecordPathInput): string;
export function generateRecordPath(
  kind: string,
  title: string,
  labId: string,
  startedAt: string | Date,
): string;
export function generateRecordPath(
  inputOrKind: RecordPathInput | string,
  title?: string,
  labId?: string,
  startedAt?: string | Date,
): string {
  const input: RecordPathInput =
    typeof inputOrKind === "string"
      ? {
          kind: inputOrKind,
          title: title as string,
          labId: labId as string,
          startedAt: startedAt as string | Date,
        }
      : inputOrKind;
  if (!input || typeof input !== "object") throw new TypeError("record path input is required");
  const date = shanghaiDateParts(input.startedAt);
  return [
    "records",
    kindDirectory(input.kind),
    date.year,
    date.month,
    `${slugify(input.title)}--${labId8(input.labId)}.md`,
  ].join("/");
}

export const recordPath = generateRecordPath;
export const buildRecordPath = generateRecordPath;

function normalizeMetadata(metadata: LabMetadata | undefined): Readonly<Record<string, LabMetadataValue>> {
  if (metadata === undefined) return Object.freeze({});
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("metadata must be an object");
  }
  const result: Record<string, LabMetadataValue> = {};
  for (const key of Object.keys(metadata).sort()) {
    const safeKey = normalizeSingleLine(key, 64, "metadata key");
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(safeKey)) {
      throw new TypeError(`invalid metadata key: ${key}`);
    }
    const value = metadata[key];
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new TypeError(`metadata value for ${key} must be scalar`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`metadata value for ${key} must be finite`);
    }
    result[safeKey] = typeof value === "string" ? normalizeSingleLine(value, 500, key) : value;
  }
  return Object.freeze(result);
}

export function createLabRecord(params: LabSaveParams): LabRecord {
  if (!params || typeof params !== "object") throw new TypeError("params are required");
  const labId = normalizeSingleLine(params.labId, LAB_RECORD_LIMITS.labId, "labId");
  labId8(labId); // Validate suitability for a path before doing any rendering.
  const title = normalizeTitle(params.title);
  const kind = normalizeKind(params.kind);
  const started = parseInstant(params.startedAt, "startedAt");
  const ended = params.endedAt == null ? null : parseInstant(params.endedAt, "endedAt");
  if (ended && ended.getTime() < started.getTime()) {
    throw new RangeError("endedAt must not be before startedAt");
  }
  if (params.body !== undefined && params.content !== undefined && params.body !== params.content) {
    throw new TypeError("provide body or content, not two different values");
  }
  const body = normalizeMultiline(
    params.body ?? params.content ?? "",
    "body",
    LAB_RECORD_LIMITS.body,
  );
  const summary = normalizeMultiline(params.summary ?? "", "summary", LAB_RECORD_LIMITS.summary);
  const record: LabRecord = {
    schema: "pi-labbook/v1",
    labId,
    kind,
    title,
    startedAt: started.toISOString(),
    endedAt: ended?.toISOString() ?? null,
    summary,
    tags: Object.freeze(normalizeTags(params.tags)),
    metadata: normalizeMetadata(params.metadata),
    body,
    relativePath: generateRecordPath({ kind, title, labId, startedAt: started }),
  };
  return Object.freeze(record);
}

/** JSON strings/scalars are a safe YAML 1.2 subset and cannot inject new keys. */
function yamlScalar(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("frontmatter value is not serializable");
  return encoded;
}

export function renderLabRecord(recordOrParams: LabRecord | LabSaveParams): string {
  const record: LabRecord =
    "relativePath" in recordOrParams ? recordOrParams : createLabRecord(recordOrParams);
  const lines = [
    "---",
    `schema: ${yamlScalar(record.schema)}`,
    `lab_id: ${yamlScalar(record.labId)}`,
    `kind: ${yamlScalar(record.kind)}`,
    `title: ${yamlScalar(record.title)}`,
    `started_at: ${yamlScalar(record.startedAt)}`,
    `ended_at: ${yamlScalar(record.endedAt)}`,
    `summary: ${yamlScalar(record.summary)}`,
    `tags: ${yamlScalar([...record.tags])}`,
    `metadata: ${yamlScalar(record.metadata)}`,
    "---",
    "",
    `# ${record.title}`,
  ];
  if (record.body) lines.push("", record.body);
  return `${lines.join("\n")}\n`;
}

export const renderRecordMarkdown = renderLabRecord;
export const renderMarkdown = renderLabRecord;

function locationFor(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: index - lastNewline,
  };
}

interface FindingPattern {
  type: SecretFindingType;
  expression: RegExp;
  message: string;
}

const SECRET_PATTERNS: readonly FindingPattern[] = [
  {
    type: "private-key",
    expression:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    message: "Private key header detected",
  },
  {
    type: "github-token",
    expression: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
    message: "GitHub token detected",
  },
  {
    type: "aws-access-key",
    expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    message: "AWS access key ID detected",
  },
  {
    type: "aws-secret-key",
    expression:
      /\bAWS_SECRET_ACCESS_KEY\b\s*(?:=|:)\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    message: "AWS secret access key assignment detected",
  },
];

const PLACEHOLDER_SECRET = /^(?:\*+|x+|redacted|example|sample|dummy|changeme|password|secret|none|null|undefined|<[^>]+>|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*)$/i;
const ASSIGNMENT = /\b(password|passwd|pwd|api[_-]?key)\b["']?\s*(?:=|:)\s*(?:["'`]([^"'`\r\n]+)["'`]|([^\s#,;]+))/gi;

/** Scan text without ever returning the detected secret in a finding. */
export function scanSecrets(text: string): SecretFinding[] {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  const raw: Array<{ type: SecretFindingType; index: number; end: number; message: string }> = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.expression.exec(text)) !== null) {
      raw.push({
        type: pattern.type,
        index: match.index,
        end: match.index + match[0].length,
        message: pattern.message,
      });
    }
  }

  ASSIGNMENT.lastIndex = 0;
  let assignment: RegExpExecArray | null;
  while ((assignment = ASSIGNMENT.exec(text)) !== null) {
    const value = (assignment[2] ?? assignment[3] ?? "").trim();
    const key = assignment[1].toLowerCase();
    const minimumLength = key.includes("api") ? 8 : 4;
    if (codePointLength(value) >= minimumLength && !PLACEHOLDER_SECRET.test(value)) {
      raw.push({
        type: "credential-assignment",
        index: assignment.index,
        end: assignment.index + assignment[0].length,
        message: `Obvious ${key.includes("api") ? "API key" : "password"} assignment detected`,
      });
    }
  }

  raw.sort((left, right) => left.index - right.index || left.type.localeCompare(right.type));
  const seen = new Set<string>();
  const findings: SecretFinding[] = [];
  for (const item of raw) {
    const identity = `${item.type}:${item.index}:${item.end}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const location = locationFor(text, item.index);
    findings.push({
      type: item.type,
      kind: item.type,
      index: item.index,
      end: item.end,
      line: location.line,
      column: location.column,
      message: item.message,
      preview: `[REDACTED ${item.type}]`,
    });
  }
  return findings;
}

export const scanForSecrets = scanSecrets;

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

/**
 * Resolve an internal path and reject absolute paths or lexical traversal outside
 * the repository. This is deliberately filesystem-independent; callers writing
 * through untrusted existing symlinks should additionally use realpath/openat.
 */
export function resolveContainedPath(repositoryRoot: string, internalPath: string): string {
  if (!repositoryRoot || typeof repositoryRoot !== "string") {
    throw new TypeError("repositoryRoot must be a non-empty string");
  }
  if (!internalPath || typeof internalPath !== "string") {
    throw new TypeError("internalPath must be a non-empty string");
  }
  if (
    internalPath.includes("\0") ||
    path.isAbsolute(internalPath) ||
    path.win32.isAbsolute(internalPath) ||
    hasTraversalSegment(internalPath)
  ) {
    throw new Error("path escapes repository");
  }
  const root = path.resolve(repositoryRoot);
  const candidate = path.resolve(root, internalPath);
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("path escapes repository");
  }
  return candidate;
}

/** Assert that an already resolved candidate is contained by repositoryRoot. */
export function assertContainedPath(repositoryRoot: string, candidatePath: string): string {
  if (!repositoryRoot || !candidatePath) throw new TypeError("both paths are required");
  const root = path.resolve(repositoryRoot);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("path escapes repository");
  }
  return candidate;
}

export const ensureContainedPath = resolveContainedPath;
