/**
 * ClaudeAdapter - Claude Agent implementation of the provider adapter contract.
 *
 * Uses Anthropic's Agent SDK to run Claude-backed sessions while preserving the
 * shared provider runtime event model used elsewhere in the server.
 *
 * @module ClaudeAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ClaudeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claudeAgent";
}

export class ClaudeAdapter extends ServiceMap.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "t3/provider/Services/ClaudeAdapter",
) {}
