import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDiagram, transitionTable } from "../src/index.js";

// Tests run compiled: dist/test/diagram.test.js -> CLI is dist/src/diagram.js,
// repo root (for README.md) is two levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "diagram.js");
const README = readFileSync(join(HERE, "..", "..", "README.md"), "utf8");

test("generated diagram contains every transition edge plus start/terminal lines", () => {
  const diagram = stateDiagram();
  const lines = diagram.split("\n");
  assert.equal(lines[0], "```mermaid");
  assert.equal(lines[1], "stateDiagram-v2");
  assert.equal(lines[lines.length - 1], "```");
  assert.ok(lines.includes("    [*] --> CREATED"), "start line missing");

  const edges = transitionTable();
  assert.equal(edges.length, 14); // must match TRANSITIONS in src/stateMachine.ts
  for (const { from, event, to } of edges) {
    assert.ok(
      lines.includes(`    ${from} --> ${to} : ${event}`),
      `diagram missing edge: ${from} --> ${to} : ${event}`,
    );
  }
  for (const terminal of ["RELEASED", "REFUNDED", "EXPIRED"]) {
    assert.ok(
      lines.includes(`    ${terminal} --> [*]`),
      `diagram missing terminal line: ${terminal}`,
    );
  }
  // 2 header lines + start + 14 edges + 3 terminals + closing fence.
  assert.equal(lines.length, 2 + 1 + 14 + 3 + 1);
});

test("stateDiagram is deterministic: repeated calls are byte-identical", () => {
  assert.equal(stateDiagram(), stateDiagram());
});

test("README embeds the exact generated diagram block", () => {
  assert.ok(
    README.includes(stateDiagram()),
    "README state diagram drifted from code — regenerate via `npm run diagram`",
  );
});

test("diagram CLI prints the generated diagram verbatim", () => {
  const out = execFileSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(out.trim(), stateDiagram().trim());
  const outAgain = execFileSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(outAgain, out);
});

test("diagram --check passes when README is in sync", () => {
  // Derives the repo root from its own location, so this works regardless
  // of the caller's cwd; exit code 0 means in sync.
  const out = execFileSync(process.execPath, [CLI, "--check"], {
    encoding: "utf8",
  });
  assert.match(out, /in sync/);
});

test("diagram --write emits bare mermaid source without fences", () => {
  const dir = mkdtempSync(join(tmpdir(), "escrow-diagram-"));
  const target = join(dir, "escrow.mmd");
  const out = execFileSync(process.execPath, [CLI, "--write", target], {
    encoding: "utf8",
  });
  assert.match(out, /wrote mermaid diagram/);
  const written = readFileSync(target, "utf8");
  assert.ok(!written.includes("```"), "bare source must not contain fences");
  const bare = stateDiagram()
    .replace(/^```mermaid\n/, "")
    .replace(/\n```$/, "");
  assert.equal(written, bare + "\n");
});
