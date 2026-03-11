import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CopilotAuthPollResult, CopilotAuthStartResult } from "@t3tools/contracts";
import type { CopilotOAuthError } from "../Errors";

export interface CopilotOAuthShape {
  readonly startDeviceAuth: () => Effect.Effect<CopilotAuthStartResult, CopilotOAuthError>;
  readonly pollDeviceAuth: (authId: string) => Effect.Effect<CopilotAuthPollResult, CopilotOAuthError>;
}

export class CopilotOAuth extends ServiceMap.Service<CopilotOAuth, CopilotOAuthShape>()(
  "t3/provider/Services/CopilotOAuth",
) {}
