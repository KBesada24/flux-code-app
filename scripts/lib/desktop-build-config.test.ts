import { describe, expect, it } from "vitest";

import { createDesktopBuildConfig } from "./desktop-build-config";

describe("createDesktopBuildConfig", () => {
  it("uses desktop resources as build resources and ships runtime icon assets", () => {
    const buildConfig = createDesktopBuildConfig({
      platform: "linux",
      target: "AppImage",
      productName: "T3 Code (Alpha)",
    });

    expect(buildConfig.directories).toEqual({
      buildResources: "apps/desktop/resources",
    });
    expect(buildConfig.extraResources).toEqual([
      {
        from: "apps/desktop/resources/icon.png",
        to: "runtime-assets/desktop/icon.png",
      },
      {
        from: "apps/desktop/resources/icon.ico",
        to: "runtime-assets/desktop/icon.ico",
      },
      {
        from: "apps/desktop/resources/icon.icns",
        to: "runtime-assets/desktop/icon.icns",
      },
    ]);
  });

  it("sets Linux icon and window manager identity metadata", () => {
    const buildConfig = createDesktopBuildConfig({
      platform: "linux",
      target: "AppImage",
      productName: "T3 Code (Alpha)",
    });

    expect(buildConfig.linux).toEqual({
      target: ["AppImage"],
      icon: "icon.png",
      category: "Development",
      executableName: "t3code",
      desktop: {
        entry: {
          StartupWMClass: "t3code",
        },
      },
    });
  });
});
