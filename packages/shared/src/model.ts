import {
  CLAUDE_REASONING_EFFORT_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  type ModelSlug,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type ProviderReasoningEffort,
  type ProviderKind,
} from "@t3tools/contracts";

type CatalogProvider = keyof typeof MODEL_OPTIONS_BY_PROVIDER;

const MODEL_SLUG_SET_BY_PROVIDER: Record<CatalogProvider, ReadonlySet<ModelSlug>> = {
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  "github-copilot": new Set(
    MODEL_OPTIONS_BY_PROVIDER["github-copilot"].map((option) => option.slug),
  ),
  claudeAgent: new Set(MODEL_OPTIONS_BY_PROVIDER.claudeAgent.map((option) => option.slug)),
};

const CLAUDE_OPUS_4_6_MODEL = "claude-opus-4-6";
const CLAUDE_SONNET_4_6_MODEL = "claude-sonnet-4-6";

export function inferProviderForModel(
  model: string | null | undefined,
  fallback: ProviderKind = "codex",
): ProviderKind {
  const normalizedClaude = normalizeModelSlug(model, "claudeAgent");
  if (normalizedClaude && MODEL_SLUG_SET_BY_PROVIDER.claudeAgent.has(normalizedClaude)) {
    return "claudeAgent";
  }

  const normalizedCodex = normalizeModelSlug(model, "codex");
  if (normalizedCodex && MODEL_SLUG_SET_BY_PROVIDER.codex.has(normalizedCodex)) {
    return "codex";
  }

  const normalizedCopilot = normalizeModelSlug(model, "github-copilot");
  if (normalizedCopilot && MODEL_SLUG_SET_BY_PROVIDER["github-copilot"].has(normalizedCopilot)) {
    return "github-copilot";
  }

  return typeof model === "string" && model.trim().startsWith("claude-")
    ? "claudeAgent"
    : fallback;
}

export function supportsClaudeMaxEffort(model: string | null | undefined): boolean {
  return normalizeModelSlug(model, "claudeAgent") === CLAUDE_OPUS_4_6_MODEL;
}

export function supportsClaudeUltrathinkKeyword(model: string | null | undefined): boolean {
  const normalized = normalizeModelSlug(model, "claudeAgent");
  return normalized === CLAUDE_OPUS_4_6_MODEL || normalized === CLAUDE_SONNET_4_6_MODEL;
}

export function resolveReasoningEffortForProvider(
  provider: "codex",
  effort: string | null | undefined,
): CodexReasoningEffort | null;
export function resolveReasoningEffortForProvider(
  provider: "claudeAgent",
  effort: string | null | undefined,
): ClaudeReasoningEffort | null;
export function resolveReasoningEffortForProvider(
  provider: ProviderKind,
  effort: string | null | undefined,
): ProviderReasoningEffort | null;
export function resolveReasoningEffortForProvider(
  provider: ProviderKind,
  effort: string | null | undefined,
): ProviderReasoningEffort | null {
  if (typeof effort !== "string") {
    return null;
  }

  const trimmed = effort.trim();
  if (!trimmed) {
    return null;
  }

  const supportedEfforts = REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider] as ReadonlyArray<
    ProviderReasoningEffort
  >;
  return supportedEfforts.includes(trimmed as ProviderReasoningEffort)
    ? (trimmed as ProviderReasoningEffort)
    : null;
}

export function getEffectiveClaudeCodeEffort(
  effort: ClaudeReasoningEffort | null | undefined,
): Exclude<ClaudeReasoningEffort, "ultrathink"> | null {
  if (!effort || effort === "ultrathink") {
    return null;
  }
  return effort;
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: ClaudeReasoningEffort | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed || effort !== "ultrathink") {
    return trimmed;
  }
  return trimmed.startsWith("Ultrathink:") ? trimmed : `Ultrathink:\n${trimmed}`;
}

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  const aliased = aliases[trimmed];
  return typeof aliased === "string" ? aliased : (trimmed as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return getDefaultModel(provider);
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : getDefaultModel(provider);
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
  model?: string | null,
): ReadonlyArray<ProviderReasoningEffort> {
  if (provider === "claudeAgent") {
    if (supportsClaudeMaxEffort(model)) {
      return CLAUDE_REASONING_EFFORT_OPTIONS;
    }
    if (supportsClaudeUltrathinkKeyword(model)) {
      return ["low", "medium", "high", "ultrathink"];
    }
    return [];
  }

  return provider === "codex" ? CODEX_REASONING_EFFORT_OPTIONS : [];
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: "claudeAgent"): ClaudeReasoningEffort;
export function getDefaultReasoningEffort(provider: ProviderKind): ProviderReasoningEffort | null;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): ProviderReasoningEffort | null {
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider];
}

export { CODEX_REASONING_EFFORT_OPTIONS };
