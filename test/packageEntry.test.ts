import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Guards the package entry point: package.json used to declare
// `main: dist/index.js` / `types: dist/index.d.ts`, but tsc emits the
// entry at dist/src/index.js (the tsconfig include spans src/, test/
// and bench/, so the common root is the repo root). Resolving the
// package by its declared `main` therefore failed with
// ERR_MODULE_NOT_FOUND, and the README Quickstart repeated the same
// wrong path. These tests pin `main`/`types` to the real build
// layout, assert the declared files exist after build, and import
// through `main` to prove the core API is reachable and usable.
//
// The `exports` map is pinned here too: package.json used to declare
// only `main`/`types`, so how modern Node and bundlers resolve the
// package by name — and which subpaths exist — was uncontrolled. The
// `exports` map is now the controlled entry (`.` -> dist/src/, this
// repo's actual tsc emit layout), `main`/`types` are kept for older
// resolvers, and all three must agree and point at real build output.
// Mirrors the dataquest pilot (#184) and the rfc9421 follow-up (#192);
// this repo was the last of the three without an exports map.

const repoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
); // dist/test/*.test.js -> repo root

type PackageJson = {
  name: string;
  main?: string;
  types?: string;
  exports?: Record<string, Record<string, string> | string>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as PackageJson;
}

function stripDotSlash(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

test("package.json main/types point at the real build layout (dist/src/)", () => {
  const pkg = readPackageJson();
  assert.equal(pkg.main, "dist/src/index.js");
  assert.equal(pkg.types, "dist/src/index.d.ts");
});

test("package.json declares an exports map for '.' with types/import/default", () => {
  const pkg = readPackageJson();
  assert.ok(pkg.exports, "package.json must declare an exports map");
  const dot = pkg.exports["."];
  assert.ok(dot && typeof dot === "object", "exports must define a '.' entry");
  assert.equal(dot.types, "./dist/src/index.d.ts");
  assert.equal(dot.import, "./dist/src/index.js");
  assert.equal(dot.default, "./dist/src/index.js");
});

test("exports, main and types agree on the same entry files", () => {
  const pkg = readPackageJson();
  const dot = pkg.exports?.["."] as Record<string, string>;
  assert.equal(stripDotSlash(dot.import), pkg.main);
  assert.equal(stripDotSlash(dot.default), pkg.main);
  assert.equal(stripDotSlash(dot.types), pkg.types);
});

test("every declared entry file exists after build", () => {
  const pkg = readPackageJson();
  const dot = pkg.exports?.["."] as Record<string, string>;
  for (const target of [pkg.main, pkg.types, dot.types, dot.import, dot.default]) {
    assert.ok(target, "entry target must be declared");
    const resolved = path.join(repoRoot, stripDotSlash(target));
    assert.ok(
      existsSync(resolved),
      `declared entry "${target}" does not exist after build`,
    );
  }
});

test("importing via the declared main entry exposes a usable core API", async () => {
  const pkg = readPackageJson();
  assert.ok(pkg.main);
  const mod = (await import(
    pathToFileURL(path.join(repoRoot, pkg.main)).href
  )) as Record<string, unknown>;
  assert.equal(typeof mod.Escrow, "function");
  assert.equal(typeof mod.calculateDeposit, "function");
  assert.equal(typeof mod.settleRelease, "function");

  // The imported API must actually work, not just exist: the golden
  // fee vector from the case study and a minimal escrow lifecycle.
  const calculateDeposit = mod.calculateDeposit as (inputs: {
    creatorPool: number;
    baseFee: number;
    complexityMultiplier: number;
    loyaltyDiscount: number;
    oracleFee: number;
  }) => { deposit: number };
  const fees = calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
  assert.equal(fees.deposit, 10630);

  const Escrow = mod.Escrow as new (id: string) => {
    state: string;
    dispatch: (event: string, note?: string, amount?: number) => void;
  };
  const escrow = new Escrow("entry-smoke-1");
  escrow.dispatch("FUND", "wire received", 10630);
  assert.equal(escrow.state, "FUNDED");
});

test("self-referencing import by package name exposes a usable core API", async () => {
  const pkg = readPackageJson();
  // Non-literal specifier: the package name is read from package.json
  // itself, so a rename or a broken exports map fails here, not a
  // hard-coded string that happens to match.
  const specifier: string = pkg.name;
  const mod = (await import(specifier)) as Record<string, unknown>;
  assert.equal(typeof mod.Escrow, "function");
  assert.equal(typeof mod.calculateDeposit, "function");
  assert.equal(typeof mod.settleRelease, "function");

  const calculateDeposit = mod.calculateDeposit as (inputs: {
    creatorPool: number;
    baseFee: number;
    complexityMultiplier: number;
    loyaltyDiscount: number;
    oracleFee: number;
  }) => { deposit: number };
  const fees = calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
  assert.equal(fees.deposit, 10630);

  const Escrow = mod.Escrow as new (id: string) => {
    state: string;
    dispatch: (event: string, note?: string, amount?: number) => void;
  };
  const escrow = new Escrow("exports-smoke-1");
  escrow.dispatch("FUND", "wire received", 10630);
  assert.equal(escrow.state, "FUNDED");
});

test("importing via the main entry resolves the same module as self-reference", async () => {
  const pkg = readPackageJson();
  assert.ok(pkg.main);
  const byMain = (await import(
    pathToFileURL(path.join(repoRoot, pkg.main)).href
  )) as Record<string, unknown>;
  const specifier: string = pkg.name;
  const byName = (await import(specifier)) as Record<string, unknown>;
  assert.equal(byName.Escrow, byMain.Escrow);
  assert.equal(byName.calculateDeposit, byMain.calculateDeposit);
});

test("README Quickstart imports from the declared main entry path", () => {
  const pkg = readPackageJson();
  assert.ok(pkg.main);
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.ok(
    readme.includes(`from "./${pkg.main}"`),
    `README Quickstart must import from "./${pkg.main}" (the declared main entry)`,
  );
  assert.ok(
    !readme.includes('from "./dist/index.js"'),
    "README must not reference the non-existent dist/index.js entry",
  );
});
