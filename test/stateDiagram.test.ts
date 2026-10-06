import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transition, transitionTable } from "../src/index.js";
import type { EscrowEvent, EscrowState } from "../src/index.js";

// Compiled tests live in dist/test/, so the repo-root README is two levels up.
const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

function mermaidEdges(md: string): string[] {
  const block = md.match(/```mermaid\n([\s\S]*?)```/);
  assert.ok(block, "README must contain a mermaid diagram block");
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("-->"));
}

test("README mermaid diagram lists exactly the code's transition edges", () => {
  const edges = transitionTable();
  assert.equal(edges.length, 14); // must match TRANSITIONS in src/stateMachine.ts
  const lines = mermaidEdges(README);

  // every declared edge appears in the diagram with its event label
  for (const { from, event, to } of edges) {
    const expected = `${from} --> ${to} : ${event}`;
    assert.ok(lines.includes(expected), `diagram missing edge: ${expected}`);
  }

  // every labeled diagram edge corresponds to a real, valid transition
  for (const line of lines) {
    if (line.includes("[*]")) continue;
    const parsed = line.match(/^(\w+) --> (\w+) : (\w+)$/);
    assert.ok(parsed, `unexpected diagram line format: ${line}`);
    const [, from, to, event] = parsed;
    assert.equal(
      transition(from as EscrowState, event as EscrowEvent),
      to,
      `diagram edge does not match code: ${line}`,
    );
  }
});

test("README mermaid diagram marks start and terminal states", () => {
  const lines = mermaidEdges(README);
  assert.ok(lines.includes("[*] --> CREATED"), "diagram must show CREATED as the start");
  for (const s of ["RELEASED", "REFUNDED", "EXPIRED"]) {
    assert.ok(
      lines.includes(`${s} --> [*]`),
      `diagram must show ${s} as terminal`,
    );
  }
});
