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

const repoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
); // dist/test/*.test.js -> repo root

type PackageJson = {
  main?: string;
  types?: string;
};

function readPackageJson(): PackageJson {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as PackageJson;
}

test("package.json main/types point at the real build layout (dist/src/)", () => {
  const pkg = readPackageJson();
  assert.equal(pkg.main, "dist/src/index.js");
  assert.equal(pkg.types, "dist/src/index.d.ts");
});

test("every declared entry file exists after build", () => {
  const pkg = readPackageJson();
  for (const target of [pkg.main, pkg.types]) {
    assert.ok(target, "entry target must be declared");
    const resolved = path.join(repoRoot, target);
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
