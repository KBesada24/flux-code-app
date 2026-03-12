import { Effect, Layer } from "effect";
import { PtyAdapter, PtyAdapterShape, PtySpawnError } from "../Services/PTY";

export const DisabledPtyAdapterLive = Layer.succeed(
  PtyAdapter,
  {
    spawn: () =>
      Effect.fail(
        new PtySpawnError({
          adapter: "disabled",
          message: "Terminal unavailable: node-pty native module not loaded",
        }),
      ),
  } satisfies PtyAdapterShape,
);
