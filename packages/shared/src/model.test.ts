import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_BY_PROVIDER, MODEL_OPTIONS_BY_PROVIDER } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  getDefaultModel,
  getDefaultReasoningEffort,
  getEffectiveClaudeCodeEffort,
  getModelOptions,
  getReasoningEffortOptions,
  inferProviderForModel,
  normalizeModelSlug,
  resolveModelSlug,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("sonnet", "claudeAgent")).toBe("claude-sonnet-4-6");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS_BY_PROVIDER.codex) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });
  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS_BY_PROVIDER.codex);
  });

  it("resolves Copilot models and falls back to Copilot defaults", () => {
    expect(resolveModelSlug("unknown", "github-copilot")).toBe(
      DEFAULT_MODEL_BY_PROVIDER["github-copilot"],
    );
    for (const model of MODEL_OPTIONS_BY_PROVIDER["github-copilot"]) {
      expect(resolveModelSlug(model.slug, "github-copilot")).toBe(model.slug);
    }
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it("returns no reasoning options for copilot", () => {
    expect(getReasoningEffortOptions("github-copilot")).toEqual([]);
  });

  it("returns Claude reasoning options based on model capability", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-opus-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
      "ultrathink",
    ]);
    expect(getReasoningEffortOptions("claudeAgent", "claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "ultrathink",
    ]);
    expect(getReasoningEffortOptions("claudeAgent", "claude-haiku-4-5")).toEqual([]);
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe("high");
    expect(getDefaultReasoningEffort("github-copilot")).toBeNull();
    expect(getDefaultReasoningEffort("claudeAgent")).toBe("high");
  });
});

describe("inferProviderForModel", () => {
  it("infers Claude provider models from the model slug", () => {
    expect(inferProviderForModel("claude-opus-4-6")).toBe("claudeAgent");
  });
});

describe("Claude effort helpers", () => {
  it("maps ultrathink to prompt prefix instead of SDK effort", () => {
    expect(getEffectiveClaudeCodeEffort("ultrathink")).toBeNull();
    expect(applyClaudePromptEffortPrefix("Review this change", "ultrathink")).toBe(
      "Ultrathink:\nReview this change",
    );
  });
});
