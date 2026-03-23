import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { getResourcePathCandidates } from "./resourcePaths";

describe("getResourcePathCandidates", () => {
  it("prefers the local desktop resources directory in development", () => {
    const dirname = "/repo/apps/desktop/dist-electron";
    const resourcesPath = "/tmp/electron/resources";

    expect(
      getResourcePathCandidates("icon.png", {
        dirname,
        resourcesPath,
        isPackaged: false,
      }),
    ).toEqual([
      Path.join(dirname, "../resources", "icon.png"),
      Path.join(resourcesPath, "runtime-assets/desktop", "icon.png"),
      Path.join(resourcesPath, "resources", "icon.png"),
      Path.join(resourcesPath, "icon.png"),
    ]);
  });

  it("prefers packaged runtime assets before legacy packaged fallbacks", () => {
    const dirname = "/opt/T3 Code/resources/app/apps/desktop/dist-electron";
    const resourcesPath = "/opt/T3 Code/resources";

    expect(
      getResourcePathCandidates("icon.png", {
        dirname,
        resourcesPath,
        isPackaged: true,
      }),
    ).toEqual([
      Path.join(resourcesPath, "runtime-assets/desktop", "icon.png"),
      Path.join(dirname, "../resources", "icon.png"),
      Path.join(resourcesPath, "resources", "icon.png"),
      Path.join(resourcesPath, "icon.png"),
    ]);
  });
});
