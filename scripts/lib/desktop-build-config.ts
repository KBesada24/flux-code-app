import {
  DESKTOP_ICON_FILE_NAMES,
  DESKTOP_RUNTIME_ASSET_DIR,
} from "@t3tools/shared/desktopAssets";

export type DesktopBuildPlatform = "mac" | "linux" | "win";

export interface GitHubPublishConfig {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
  readonly releaseType: "release";
}

export interface DesktopBuildConfigOptions {
  readonly platform: DesktopBuildPlatform;
  readonly target: string;
  readonly productName: string;
  readonly publishConfig?: GitHubPublishConfig;
}

export type DesktopBuildConfig = Record<string, unknown> & {
  win?: Record<string, unknown>;
};

function createRuntimeIconResourceEntries() {
  return DESKTOP_ICON_FILE_NAMES.map((fileName) => ({
    from: `apps/desktop/resources/${fileName}`,
    to: `${DESKTOP_RUNTIME_ASSET_DIR}/${fileName}`,
  }));
}

export function createDesktopBuildConfig({
  platform,
  target,
  productName,
  publishConfig,
}: DesktopBuildConfigOptions): DesktopBuildConfig {
  const buildConfig: DesktopBuildConfig = {
    appId: "com.t3tools.t3code",
    productName,
    artifactName: "T3-Code-${version}-${arch}.${ext}",
    directories: {
      buildResources: "apps/desktop/resources",
    },
    extraResources: createRuntimeIconResourceEntries(),
    // Skip @electron/rebuild: node-pty ships prebuilds for macOS/Windows and loads
    // them at runtime via process.arch detection; msgpackr-extract gracefully
    // falls back to pure-JS when no ARM64 native binary is present.
    // Linux has no prebuilds, so node-pty is rebuilt explicitly after npm install (see below).
    npmRebuild: false,
  };

  if (publishConfig) {
    buildConfig.publish = [publishConfig];
  }

  if (platform === "mac") {
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
    };
  }

  if (platform === "linux") {
    buildConfig.linux = {
      target: [target],
      icon: "icon.png",
      category: "Development",
      executableName: "t3code",
      desktop: {
        entry: {
          StartupWMClass: "t3code",
        },
      },
    };
    buildConfig.asarUnpack = [
      "node_modules/node-pty/build/**",
      "node_modules/node-pty/prebuilds/**",
    ];
  }

  if (platform === "win") {
    buildConfig.win = {
      target: [target],
      icon: "icon.ico",
    };
  }

  return buildConfig;
}
