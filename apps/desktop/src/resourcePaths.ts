import * as Path from "node:path";

import { DESKTOP_RUNTIME_ASSET_DIR } from "@t3tools/shared/desktopAssets";

export interface ResourcePathContext {
  readonly dirname: string;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
}

function dedupePaths(paths: ReadonlyArray<string>): Array<string> {
  return [...new Set(paths)];
}

export function getResourcePathCandidates(
  fileName: string,
  { dirname, resourcesPath, isPackaged }: ResourcePathContext,
): Array<string> {
  const packagedCandidates = [
    Path.join(resourcesPath, DESKTOP_RUNTIME_ASSET_DIR, fileName),
    Path.join(dirname, "../resources", fileName),
    Path.join(resourcesPath, "resources", fileName),
    Path.join(resourcesPath, fileName),
  ];

  if (isPackaged) {
    return dedupePaths(packagedCandidates);
  }

  return dedupePaths([
    Path.join(dirname, "../resources", fileName),
    ...packagedCandidates,
  ]);
}

export function resolveExistingResourcePath(
  fileName: string,
  context: ResourcePathContext,
  exists: (path: string) => boolean,
): string | null {
  for (const candidate of getResourcePathCandidates(fileName, context)) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  return null;
}
