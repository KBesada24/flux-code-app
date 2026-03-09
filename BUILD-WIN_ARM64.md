# Building the Windows ARM64 Installer

Produces `./release/T3-Code-<version>-arm64.exe` — a native ARM64 NSIS installer.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Windows ARM64 | 10/11 | Build machine must be ARM64 |
| [Node.js](https://nodejs.org/) | ^24.13.1 | Provides `npm`, used for staging install |
| [Bun](https://bun.sh/) | ^1.3.9 | Drives the build script and TypeScript compilation |
| Internet access | — | Downloads the ARM64 Electron binary (~138 MB) on first run |

> **No Visual Studio or Python required.** Native module rebuilding is disabled; `node-pty` ships pre-built ARM64 binaries inside its npm package and `msgpackr-extract` falls back to pure JavaScript.

## Steps

### 1. Install dependencies

```
bun install
```

### 2. Build

```
bun scripts/build-desktop-artifact.ts --platform win --target nsis --arch arm64
```

This single command:
1. Compiles the desktop main process and server (tsdown via turbo)
2. Builds the web UI (Vite via turbo)
3. Creates a temporary staging directory
4. Runs `npm install --omit=dev --ignore-scripts` in staging
5. Downloads `electron-v*-win32-arm64.zip` on first run (cached afterwards)
6. Packages everything into an NSIS installer

### 3. Output

```
./release/T3-Code-<version>-arm64.exe
./release/T3-Code-<version>-arm64.exe.blockmap
```

## Useful flags

| Flag | Effect |
|------|--------|
| `--verbose` | Stream all subprocess output to the terminal |
| `--keep-stage` | Preserve the temporary staging directory after the build |
| `--skip-build` | Skip TypeScript compilation (reuse existing `dist` artifacts) |
| `--output-dir <path>` | Write artifacts to a custom directory instead of `./release` |

## Why npm instead of bun for the staging install

The installed `bun` on Windows ARM64 machines is typically the x64 binary (`bun-windows-x64`) running under emulation. It segfaults when resolving dependencies from non-standard URLs (such as the `pkg.pr.new` preview packages used by this project) in a fresh directory. `npm`, which ships with Node.js, handles these URLs without issue.

## Caching

- Electron binaries are cached by electron-builder in `%LOCALAPPDATA%\electron\Cache` (Windows).
- Turbo caches compiled artifacts in `.turbo/`; subsequent `--skip-build` runs are near-instant.
