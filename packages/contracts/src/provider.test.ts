import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "full-access",
      providerOptions: {
        codex: {
          binaryPath: "/usr/local/bin/codex",
          homePath: "/tmp/.codex",
        },
      },
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("high");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
    expect(parsed.providerOptions?.codex?.binaryPath).toBe("/usr/local/bin/codex");
    expect(parsed.providerOptions?.codex?.homePath).toBe("/tmp/.codex");
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("accepts Claude session start options", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      runtimeMode: "full-access",
      providerOptions: {
        claudeAgent: {
          binaryPath: "/usr/local/bin/claude",
          permissionMode: "acceptEdits",
          maxThinkingTokens: 4096,
        },
      },
    });

    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.providerOptions?.claudeAgent?.binaryPath).toBe("/usr/local/bin/claude");
    expect(parsed.providerOptions?.claudeAgent?.permissionMode).toBe("acceptEdits");
    expect(parsed.providerOptions?.claudeAgent?.maxThinkingTokens).toBe(4096);
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts provider-scoped model options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    });

    expect(parsed.model).toBe("gpt-5.3-codex");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("xhigh");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
  });

  it("accepts optional history for stateless providers", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      input: "hello",
      history: [
        { role: "system", text: "You are a helpful assistant." },
        { role: "user", text: "Hi" },
        { role: "assistant", text: "Hello!" },
      ],
    });

    expect(parsed.history?.length).toBe(3);
    expect(parsed.history?.[0]?.role).toBe("system");
  });

  it("accepts Claude model options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      model: "claude-sonnet-4-6",
      modelOptions: {
        claudeAgent: {
          effort: "ultrathink",
        },
      },
    });

    expect(parsed.model).toBe("claude-sonnet-4-6");
    expect(parsed.modelOptions?.claudeAgent?.effort).toBe("ultrathink");
  });
});
