import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { ServerConfig, type ServerConfigShape } from "../../config";
import { CopilotAuthStore } from "../Services/CopilotAuthStore";
import { CopilotAuthStoreLive } from "./CopilotAuthStore";

const makeServerConfigLayer = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3code-copilot-auth-",
    });
    const config: ServerConfigShape = {
      cwd: process.cwd(),
      stateDir,
      mode: "web",
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      port: 0,
      host: undefined,
      authToken: undefined,
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: false,
    };
    return config;
  }),
);

it.layer(NodeServices.layer)("CopilotAuthStore", (it) => {
  it.effect("persists and clears Copilot auth tokens", () =>
    Effect.gen(function* () {
      const store = yield* CopilotAuthStore;

      const initial = yield* store.get;
      assert.strictEqual(Option.isSome(initial), false);

      yield* store.set({
        accessToken: "token-123",
        tokenType: "bearer",
        scopes: ["read:user"],
        acquiredAt: "2026-03-01T00:00:00.000Z",
      });

      const afterWrite = yield* store.get;
      assert.strictEqual(Option.isSome(afterWrite), true);
      if (Option.isSome(afterWrite)) {
        assert.strictEqual(afterWrite.value.accessToken, "token-123");
      }

      yield* store.clear;
      const afterClear = yield* store.get;
      assert.strictEqual(Option.isSome(afterClear), false);
    }).pipe(
      Effect.provide(
        CopilotAuthStoreLive.pipe(Layer.provide(makeServerConfigLayer)),
      ),
    ),
  );
});
