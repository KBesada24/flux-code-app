import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { ServerConfig } from "../../config";
import {
  CopilotAuthStore,
  type CopilotAuthStoreShape,
  type CopilotAuthToken,
} from "../Services/CopilotAuthStore";

type CopilotAuthRecord = {
  accessToken?: unknown;
  tokenType?: unknown;
  scopes?: unknown;
  acquiredAt?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeScopes(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const scopes = value.filter(isNonEmptyString).map((scope) => scope.trim());
  return scopes.length > 0 ? scopes : [];
}

function parseTokenRecord(value: unknown): CopilotAuthToken | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as CopilotAuthRecord;
  if (!isNonEmptyString(record.accessToken)) {
    return null;
  }
  const tokenType = isNonEmptyString(record.tokenType) ? record.tokenType.trim() : "bearer";
  const scopes = normalizeScopes(record.scopes) ?? [];
  const acquiredAt = isNonEmptyString(record.acquiredAt)
    ? record.acquiredAt.trim()
    : new Date().toISOString();

  return {
    accessToken: record.accessToken.trim(),
    tokenType,
    scopes,
    acquiredAt,
  };
}

const makeCopilotAuthStore = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  const authFilePath = path.join(stateDir, "providers", "copilot-auth.json");

  const readToken = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(authFilePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none<CopilotAuthToken>();
    }

    const contents = yield* fileSystem
      .readFileString(authFilePath)
      .pipe(Effect.catch(() => Effect.succeed("")));
    if (!contents) {
      return Option.none<CopilotAuthToken>();
    }

    const value = yield* Effect.sync(() => {
      try {
        return JSON.parse(contents);
      } catch {
        return null;
      }
    });
    const token = parseTokenRecord(value);
    return token ? Option.some(token) : Option.none<CopilotAuthToken>();
  });

  const writeToken: CopilotAuthStoreShape["set"] = (token) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(authFilePath), { recursive: true }).pipe(
        Effect.catch(() => Effect.void),
      );
      const payload = JSON.stringify(token, null, 2);
      yield* fileSystem.writeFileString(authFilePath, payload).pipe(
        Effect.catch(() => Effect.void),
      );
    });

  const clear = fileSystem.remove(authFilePath, { force: true }).pipe(
    Effect.catch(() => Effect.void),
  );

  return {
    get: readToken,
    set: writeToken,
    clear,
    has: readToken.pipe(Effect.map(Option.isSome)),
  } satisfies CopilotAuthStoreShape;
});

export const CopilotAuthStoreLive = Layer.effect(CopilotAuthStore, makeCopilotAuthStore);
