import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

export interface CopilotAuthToken {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly scopes: ReadonlyArray<string>;
  readonly acquiredAt: string;
}

export interface CopilotAuthStoreShape {
  readonly get: Effect.Effect<Option.Option<CopilotAuthToken>>;
  readonly set: (token: CopilotAuthToken) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
  readonly has: Effect.Effect<boolean>;
}

export class CopilotAuthStore extends ServiceMap.Service<
  CopilotAuthStore,
  CopilotAuthStoreShape
>()("t3/provider/Services/CopilotAuthStore") {}
