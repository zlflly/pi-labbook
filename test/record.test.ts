import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  createLabRecord,
  generateRecordPath,
  labId8,
  renderLabRecord,
  resolveContainedPath,
  scanSecrets,
  slugify,
  truncateUnicode,
} from "../src/record.js";

const baseParams = {
  labId: "0192ABCD-1234-7abc-9000-0123456789ab",
  kind: "experiment",
  title: "验证 中文标题：缓存命中率",
  startedAt: "2025-01-31T17:30:00.000Z",
  summary: "第一行\n---\nevil: true",
  tags: ["性能", "cache"],
  body: "结果稳定。",
} as const;

test("Unicode titles produce readable, bounded, traversal-free slugs", () => {
  assert.equal(slugify("  中文标题：缓存 / 命中率  "), "中文标题-缓存-命中率");
  assert.equal(slugify("../../机密/../记录"), "机密-记录");
  assert.equal(truncateUnicode("甲乙😀丙", 3), "甲乙😀");

  const veryLong = slugify("中".repeat(100));
  assert.ok(Buffer.byteLength(veryLong, "utf8") <= 120);
  assert.doesNotMatch(veryLong, /[/.\\]/);
});

test("record paths use the Asia/Shanghai start date and eight safe ID characters", () => {
  assert.equal(labId8(baseParams.labId), "0192ABCD");
  assert.equal(
    generateRecordPath(baseParams),
    "records/experiments/2025/02/验证-中文标题-缓存命中率--0192ABCD.md",
  );

  // It is still January in UTC but already February in Shanghai.
  assert.equal(
    generateRecordPath("note", "午夜记录", "12345678-abcd", "2025-01-31T16:01:00Z"),
    "records/notes/2025/02/午夜记录--12345678.md",
  );
});

test("Markdown is deterministic and frontmatter strings are JSON quoted", () => {
  const first = createLabRecord({
    ...baseParams,
    title: '标题 "quoted"\nkind: injected',
    metadata: { z: true, a: "value" },
  });
  const second = createLabRecord({
    ...baseParams,
    title: '标题 "quoted"\nkind: injected',
    metadata: { a: "value", z: true },
  });
  const markdown = renderLabRecord(first);

  assert.equal(markdown, renderLabRecord(second));
  assert.match(markdown, /^---\nschema: "pi-labbook\/v1"\n/);
  assert.match(markdown, /title: "标题 \\"quoted\\" kind: injected"/);
  assert.match(markdown, /summary: "第一行\\n---\\nevil: true"/);
  assert.match(markdown, /metadata: \{"a":"value","z":true\}/);
  assert.ok(markdown.endsWith("\n"));
  assert.equal(first.relativePath.includes(".."), false);
});

test("containment rejects traversal and absolute paths", () => {
  const root = path.resolve("/tmp/labbook-repository");
  assert.equal(
    resolveContainedPath(root, "records/notes/2025/02/a--12345678.md"),
    path.join(root, "records/notes/2025/02/a--12345678.md"),
  );
  assert.throws(() => resolveContainedPath(root, "../outside.md"), /escapes repository/);
  assert.throws(() => resolveContainedPath(root, "records\\..\\..\\outside.md"), /escapes repository/);
  assert.throws(() => resolveContainedPath(root, "/tmp/outside.md"), /escapes repository/);
  const hostileKindPath = generateRecordPath({ ...baseParams, kind: "../../outside" });
  assert.match(hostileKindPath, /^records\/outside\//);
  assert.equal(hostileKindPath.includes(".."), false);
});

test("secret scanning reports high-confidence findings without echoing secrets", () => {
  const github = `ghp_${"A".repeat(36)}`;
  const aws = `AKIA${"B".repeat(16)}`;
  const awsSecret = "c".repeat(40);
  const password = "correct horse battery staple";
  const source = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    github,
    `AWS_ACCESS_KEY_ID=${aws}`,
    `AWS_SECRET_ACCESS_KEY=${awsSecret}`,
    `password = "${password}"`,
    "api_key = ${API_KEY}", // Placeholder: intentionally not a finding.
  ].join("\n");

  const findings = scanSecrets(source);
  assert.deepEqual(
    findings.map((finding) => finding.type),
    ["private-key", "github-token", "aws-access-key", "aws-secret-key", "credential-assignment"],
  );
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [1, 2, 3, 4, 5],
  );
  for (const finding of findings) {
    assert.match(finding.preview, /^\[REDACTED /);
    assert.equal(JSON.stringify(finding).includes(github), false);
    assert.equal(JSON.stringify(finding).includes(awsSecret), false);
    assert.equal(JSON.stringify(finding).includes(password), false);
  }

  assert.deepEqual(scanSecrets("password = <redacted>\napi_key = ${API_KEY}"), []);
});
