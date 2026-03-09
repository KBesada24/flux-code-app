#!/usr/bin/env node
/**
 * Scans node_modules/.bun/ for packages with win32-x64 optional dependencies
 * and installs the corresponding win32-arm64 variants using npm (ARM64).
 *
 * Run with: node scripts/fix-arm64-bindings.mjs
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dirArgIndex = args.indexOf("--dir");
const ROOT =
  dirArgIndex !== -1 && args[dirArgIndex + 1]
    ? args[dirArgIndex + 1]
    : new URL("../", import.meta.url).pathname.replace(/^\//, "").replace(/\//g, "\\");
const BUN_DIR = join(ROOT, "node_modules", ".bun");

console.log(`Scanning ${BUN_DIR} for missing ARM64 native bindings...\n`);

if (!existsSync(BUN_DIR)) {
  console.error("node_modules/.bun not found. Run bun install first.");
  process.exit(1);
}

/** @type {Map<string, Set<string>>} dir -> set of arm64 packages to install */
const toInstall = new Map();

function markForInstall(dir, pkg) {
  if (!toInstall.has(dir)) toInstall.set(dir, new Set());
  toInstall.get(dir).add(pkg);
}

function getArm64Variant(name) {
  // Patterns:
  //   @scope/binding-win32-x64-msvc  -> @scope/binding-win32-arm64-msvc
  //   somepackage-win32-x64-msvc     -> somepackage-win32-arm64-msvc
  //   somepackage-win32-x64          -> somepackage-win32-arm64
  return name.replace(/win32-x64(-msvc)?/, "win32-arm64$1");
}

function isX64WindowsBinding(name) {
  return name.includes("win32-x64");
}

function arm64VariantInstalled(nodeModulesDir, arm64PkgName) {
  // Check if the arm64 package directory has any actual files
  const pkgDir = join(nodeModulesDir, arm64PkgName);
  if (!existsSync(pkgDir)) return false;
  try {
    const files = readdirSync(pkgDir);
    return files.length > 0;
  } catch {
    return false;
  }
}

// Scan all isolated package dirs inside .bun/
const bunEntries = readdirSync(BUN_DIR, { withFileTypes: true });

for (const entry of bunEntries) {
  if (!entry.isDirectory()) continue;

  const nodeModulesDir = join(BUN_DIR, entry.name, "node_modules");
  if (!existsSync(nodeModulesDir)) continue;

  // Check each package's package.json for optionalDependencies
  const pkgDirs = readdirSync(nodeModulesDir, { withFileTypes: true });

  for (const pkgEntry of pkgDirs) {
    if (!pkgEntry.isDirectory()) continue;

    // Handle scoped packages (@scope/pkg)
    const pkgName = pkgEntry.name;
    let pkgJsonPath;

    if (pkgName.startsWith("@")) {
      const scopedDirs = readdirSync(join(nodeModulesDir, pkgName), { withFileTypes: true }).catch?.(() => []);
      const innerPkgs = readdirSync(join(nodeModulesDir, pkgName), { withFileTypes: true });
      for (const inner of innerPkgs) {
        pkgJsonPath = join(nodeModulesDir, pkgName, inner.name, "package.json");
        checkPkgJson(pkgJsonPath, nodeModulesDir);
      }
      continue;
    }

    pkgJsonPath = join(nodeModulesDir, pkgName, "package.json");
    checkPkgJson(pkgJsonPath, nodeModulesDir);
  }

  // Also directly check top-level .node files or x64 package dirs at nodeModulesDir level
  for (const pkgEntry of pkgDirs) {
    if (pkgEntry.isDirectory() && isX64WindowsBinding(pkgEntry.name)) {
      const arm64 = getArm64Variant(pkgEntry.name);
      if (!arm64VariantInstalled(nodeModulesDir, arm64)) {
        // Find version from the x64 package
        const x64PkgJson = join(nodeModulesDir, pkgEntry.name, "package.json");
        if (existsSync(x64PkgJson)) {
          try {
            const { version } = JSON.parse(readFileSync(x64PkgJson, "utf8"));
            markForInstall(nodeModulesDir, `${arm64}@${version}`);
          } catch {}
        }
      }
    }
  }
}

function checkPkgJson(pkgJsonPath, nodeModulesDir) {
  if (!existsSync(pkgJsonPath)) return;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const optDeps = pkg.optionalDependencies ?? {};

    for (const [depName, version] of Object.entries(optDeps)) {
      if (!isX64WindowsBinding(depName)) continue;
      const arm64 = getArm64Variant(depName);
      if (!arm64VariantInstalled(nodeModulesDir, arm64)) {
        // Use same version as x64 variant
        const arm64Version = version.replace(/win32-x64(-msvc)?/, "win32-arm64$1");
        markForInstall(nodeModulesDir, `${arm64}@${version}`);
      }
    }
  } catch {}
}

if (toInstall.size === 0) {
  console.log("✓ No missing ARM64 bindings found.");
  process.exit(0);
}

let totalInstalled = 0;
let totalFailed = 0;

for (const [dir, pkgs] of toInstall) {
  for (const pkg of pkgs) {
    console.log(`Installing ${pkg}\n  in ${dir}`);
    try {
      execSync(`npm install "${pkg}" --no-save`, {
        cwd: dir,
        stdio: "pipe",
        timeout: 60000,
      });
      console.log(`  ✓ done\n`);
      totalInstalled++;
    } catch (err) {
      console.error(`  ✗ failed: ${err.message}\n`);
      totalFailed++;
    }
  }
}

console.log(`\nDone. Installed: ${totalInstalled}, Failed: ${totalFailed}`);
if (totalFailed > 0) process.exit(1);
