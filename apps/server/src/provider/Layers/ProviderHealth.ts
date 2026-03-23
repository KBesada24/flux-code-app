/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness probes when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import type {
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import { CopilotAuthStore } from "../Services/CopilotAuthStore";
import { getCopilotApiToken, COPILOT_IDE_HEADERS } from "../copilotApiToken.ts";

const DEFAULT_TIMEOUT_MS = 4_000;
const CODEX_PROVIDER = "codex" as const;
const COPILOT_PROVIDER = "github-copilot" as const;
const CLAUDE_PROVIDER = "claudeAgent" as const;

// ── Pure helpers ────────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCommandMissingCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes("command not found: codex") ||
    lower.includes("command not found: claude") ||
    lower.includes("spawn codex enoent") ||
    lower.includes("spawn claude enoent") ||
    lower.includes("enoent") ||
    lower.includes("notfound")
  );
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Claude authentication status command is unavailable in this Claude version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude auth login`") ||
    lowerOutput.includes("run claude auth login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const runCodexCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("codex", [...args], {
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runClaudeCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("claude", [...args], {
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

// ── Health check ────────────────────────────────────────────────────

export const checkCodexProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  // Probe 1: `codex --version` — is the CLI reachable?
  const versionProbe = yield* runCodexCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isCommandMissingCause(error)
        ? "Codex CLI (`codex`) is not installed or not on PATH."
        : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  if (Option.isNone(versionProbe.success)) {
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Codex CLI is installed but failed to run. Timed out while running command.",
    };
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `Codex CLI is installed but failed to run. ${detail}`
        : "Codex CLI is installed but failed to run.",
    };
  }

  // Probe 2: `codex login status` — is the user authenticated?
  const authProbe = yield* runCodexCommand(["login", "status"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return {
      provider: CODEX_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message:
        error instanceof Error
          ? `Could not verify Codex authentication status: ${error.message}.`
          : "Could not verify Codex authentication status.",
    };
  }

  if (Option.isNone(authProbe.success)) {
    return {
      provider: CODEX_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Could not verify Codex authentication status. Timed out while running command.",
    };
  }

  const parsed = parseAuthStatusFromOutput(authProbe.success.value);
  return {
    provider: CODEX_PROVIDER,
    status: parsed.status,
    available: true,
    authStatus: parsed.authStatus,
    checkedAt,
    ...(parsed.message ? { message: parsed.message } : {}),
  } satisfies ServerProviderStatus;
});

const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

export const checkCopilotProviderStatus = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();
  const authStore = yield* CopilotAuthStore;
  const tokenOption = yield* authStore.get;
  const hasToken = Option.isSome(tokenOption);

  if (!hasToken) {
    return {
      provider: COPILOT_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unauthenticated" as const,
      checkedAt,
      message: "GitHub Copilot is not authenticated. Connect in settings to continue.",
    } satisfies ServerProviderStatus;
  }

  const token = tokenOption.value;
  const models = yield* Effect.promise(async () => {
    try {
      const copilotToken = await getCopilotApiToken(token.accessToken);
      if (!copilotToken) return null;

      const response = await fetch(COPILOT_MODELS_URL, {
        headers: {
          Authorization: `Bearer ${copilotToken}`,
          "User-Agent": "t3code",
          ...COPILOT_IDE_HEADERS,
        },
      });
      if (!response.ok) return null;
      const data = (await response.json()) as {
        data?: Array<{ id: string; name?: string }>;
      };
      return (
        data.data
          ?.filter((m) => typeof m.id === "string" && m.id.length > 0)
          .map((m) => ({ slug: m.id, name: m.name ?? m.id })) ?? null
      );
    } catch {
      return null;
    }
  });

  return {
    provider: COPILOT_PROVIDER,
    status: "ready" as const,
    available: true,
    authStatus: "authenticated" as const,
    checkedAt,
    ...(models ? { models } : {}),
  } satisfies ServerProviderStatus;
});

export const checkClaudeProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  const versionProbe = yield* runClaudeCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return {
      provider: CLAUDE_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isCommandMissingCause(error)
        ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
        : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    } satisfies ServerProviderStatus;
  }

  if (Option.isNone(versionProbe.success)) {
    return {
      provider: CLAUDE_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Claude Agent CLI is installed but failed to run. Timed out while running command.",
    } satisfies ServerProviderStatus;
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return {
      provider: CLAUDE_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `Claude Agent CLI is installed but failed to run. ${detail}`
        : "Claude Agent CLI is installed but failed to run.",
    } satisfies ServerProviderStatus;
  }

  const authProbe = yield* runClaudeCommand(["auth", "status"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return {
      provider: CLAUDE_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message:
        error instanceof Error
          ? `Could not verify Claude authentication status: ${error.message}.`
          : "Could not verify Claude authentication status.",
    } satisfies ServerProviderStatus;
  }

  if (Option.isNone(authProbe.success)) {
    return {
      provider: CLAUDE_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Could not verify Claude authentication status. Timed out while running command.",
    } satisfies ServerProviderStatus;
  }

  const parsed = parseClaudeAuthStatusFromOutput(authProbe.success.value);
  return {
    provider: CLAUDE_PROVIDER,
    status: parsed.status,
    available: true,
    authStatus: parsed.authStatus,
    checkedAt,
    ...(parsed.message ? { message: parsed.message } : {}),
  } satisfies ServerProviderStatus;
});

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const authStore = yield* CopilotAuthStore;

    return {
      getStatuses: Effect.gen(function* () {
        const codexStatus = yield* checkCodexProviderStatus.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const claudeStatus = yield* checkClaudeProviderStatus.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const copilotStatus = yield* checkCopilotProviderStatus.pipe(
          Effect.provideService(CopilotAuthStore, authStore),
        );
        return [codexStatus, copilotStatus, claudeStatus];
      }),
    } satisfies ProviderHealthShape;
  }),
);
