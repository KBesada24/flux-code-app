# Building T3 Code for Fedora Linux (x64)

This guide covers everything needed to produce a Linux x64 AppImage on Fedora and install it as a desktop application.

---

## Prerequisites

### Required tools

| Tool | Minimum version | Install |
|------|----------------|---------|
| [Bun](https://bun.sh) | 1.3.9 | `curl -fsSL https://bun.sh/install \| bash` |
| Node.js | 24.13.1 | `fnm install 24` or via [nvm](https://github.com/nvm-sh/nvm) |
| Git | any recent | `sudo dnf install git` |
| Python | 3.10+ | usually pre-installed on Fedora; `sudo dnf install python3` |

> **Note:** Python is used by `node-gyp` when building native add-ons bundled into the app. It is discovered automatically; no manual configuration is needed as long as `python` or `python3` is on your `$PATH`.

### RPM packages required for electron-builder on Fedora

```bash
sudo dnf install -y \
  rpm-build \
  fuse \
  fuse-libs \
  libxcb \
  libX11 \
  libXScrnSaver \
  nss \
  atk \
  gtk3 \
  mesa-libGL
```

> `fuse` / `fuse-libs` are needed to run the produced AppImage. `rpm-build` is needed by electron-builder even when producing AppImage output.

### Build `node-pty` from source (Linux only — required for dev mode)

`node-pty` ships prebuilt native binaries only for macOS and Windows. On Linux you must compile it from source once after cloning:

```bash
bun install   # adds node-pty to trustedDependencies list
cd node_modules/.bun/node-pty@1.1.0/node_modules/node-pty
bun x node-gyp rebuild
cd -
```

This produces `node_modules/.bun/node-pty@1.1.0/node_modules/node-pty/build/Release/pty.node`.

You need to redo this step after running `bun install --frozen-lockfile` (e.g. after a `git pull` that bumps the `node-pty` version), since the cache is wiped.

> **Why this is needed:** The desktop Electron app spawns the backend server using the `bun` binary in dev mode. The server loads `node-pty` at startup to support the integrated terminal. Without a Linux native binary the server crashes in a restart loop and all WebSocket operations (including adding a project) hang for 60 seconds before timing out.

---

## One-time install (build + desktop integration)

Run this once after cloning or pulling:

```bash
bun run install:linux
```

This single command:
1. Compiles the Electron main/preload process and the web frontend (`bun run build:desktop`)
2. Packages everything into an AppImage via electron-builder (`bun run dist:desktop:linux`)
3. Copies the AppImage to `~/.local/bin/t3code.AppImage`
4. Installs the app icon to `~/.local/share/icons/hicolor/512x512/apps/t3code.png`
5. Writes `~/.local/share/applications/t3code.desktop`
6. Runs `update-desktop-database` so GNOME registers the entry immediately

After it completes, press **Super** and search **T3 Code** to launch.

---

## Individual build commands

Use these when you need fine-grained control:

```bash
# 1. Compile Electron main/preload + web frontend + server
bun run build:desktop

# 2. Package the AppImage (output: release/T3-Code-<version>-x64.AppImage)
bun run dist:desktop:linux
```

### Script internals (`scripts/build-desktop-artifact.ts`)

The `dist:desktop:linux` command calls `bun scripts/build-desktop-artifact.ts` with:

| Flag | Value |
|------|-------|
| `--platform` | `linux` |
| `--target` | `AppImage` |
| `--arch` | `x64` |

The script:
1. Runs `bun run build:desktop` (unless `--skip-build` is passed)
2. Creates a temporary staging directory and copies compiled artifacts into it
3. Copies `apps/desktop/resources/icon.png` (512×512) as the app icon
4. Writes a synthesised `package.json` for the staged app (version, electron-builder config, resolved production deps)
5. Runs `npm install --omit=dev --ignore-scripts` in the stage directory to pull in native runtime dependencies
6. Invokes `bunx electron-builder --linux --x64 --publish never`
7. Copies all produced files from the stage `dist/` into `release/`

---

## Build output

```
release/
  T3-Code-<version>-x64.AppImage   ← the distributable
  T3-Code-<version>-x64.AppImage.blockmap
  latest-linux.yml
```

The version is taken from `apps/server/package.json` (currently `0.0.3`).

---

## Environment variable overrides

All CLI flags can be set via environment variables instead:

| Variable | Description |
|----------|-------------|
| `T3CODE_DESKTOP_PLATFORM` | `linux` |
| `T3CODE_DESKTOP_TARGET` | `AppImage` (default for Linux) |
| `T3CODE_DESKTOP_ARCH` | `x64` or `arm64` |
| `T3CODE_DESKTOP_VERSION` | Override the version string |
| `T3CODE_DESKTOP_OUTPUT_DIR` | Override the output directory (default: `release/`) |
| `T3CODE_DESKTOP_SKIP_BUILD` | `true` — skip `build:desktop`, use existing artifacts |
| `T3CODE_DESKTOP_KEEP_STAGE` | `true` — keep the temp staging directory for inspection |
| `T3CODE_DESKTOP_VERBOSE` | `true` — stream all subprocess stdout |

Example — rebuild package only, reusing existing build artifacts:

```bash
T3CODE_DESKTOP_SKIP_BUILD=true bun run dist:desktop:linux
```

---

## Updating after a code change

```bash
bun run install:linux
```

Re-running the install script rebuilds everything from source and replaces the installed AppImage in place. No uninstall step is needed.

---

## Troubleshooting

**`fuse: device not found`** when running the AppImage
Install FUSE and load the kernel module:
```bash
sudo dnf install fuse fuse-libs
sudo modprobe fuse
```

**`rpm` not found** during electron-builder packaging
```bash
sudo dnf install rpm-build
```

**Python not found** (node-gyp fails)
```bash
sudo dnf install python3
# then retry:
bun run dist:desktop:linux
```

**`update-desktop-database` command not found**
The script silently ignores this error. The `.desktop` file is still written; GNOME will pick it up on next login even without running the database update.

**Adding a project hangs on "Adding..." for ~60 seconds**
`node-pty` was not built for Linux. Rebuild it from source (see [Build node-pty from source](#build-node-pty-from-source-linux-only--required-for-dev-mode) above):
```bash
cd node_modules/.bun/node-pty@1.1.0/node_modules/node-pty && bun x node-gyp rebuild && cd -
```
Confirm the fix by checking that `~/.t3/dev/logs/server.log` no longer shows the 2-second restart loop.

**App does not appear in GNOME after install**
Log out and back in, or run:
```bash
update-desktop-database ~/.local/share/applications
```
