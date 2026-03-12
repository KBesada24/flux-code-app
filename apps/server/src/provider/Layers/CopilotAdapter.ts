/**
 * CopilotAdapterLive - GitHub Copilot provider adapter.
 *
 * Implements Copilot's OpenAI-compatible chat API using SSE streaming and
 * emits canonical provider runtime events.
 *
 * @module CopilotAdapterLive
 */
import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MODEL_OPTIONS_BY_PROVIDER,
  ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { CopilotAuthStore } from "../Services/CopilotAuthStore.ts";
import { getCopilotApiToken, COPILOT_IDE_HEADERS } from "../copilotApiToken.ts";
import {
  buildCopilotSystemPrompt,
  COPILOT_TOOL_DEFINITIONS,
  executeCopilotTool,
} from "./CopilotTools.ts";

const PROVIDER = "github-copilot" as const;
const DEFAULT_BASE_URL = "https://api.githubcopilot.com";
const VALID_COPILOT_MODELS = new Set(MODEL_OPTIONS_BY_PROVIDER[PROVIDER].map((m) => m.slug));
const API_BASE_URL_ENV = "T3CODE_COPILOT_API_BASE_URL";

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type CopilotMessage =
  | {
      role: "user" | "assistant" | "system";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

// Accumulated tool call state during streaming
type CopilotToolCallAccum = {
  id: string;
  name: string;
  arguments: string;
};

type CopilotStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string } | string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function toEventId(): EventId {
  return EventId.makeUnsafe(crypto.randomUUID());
}

function toTurnId(): TurnId {
  return TurnId.makeUnsafe(crypto.randomUUID());
}

function toRuntimeItemId(): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(crypto.randomUUID());
}

function resolveApiBaseUrl(): string {
  const envValue = process.env[API_BASE_URL_ENV];
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim().replace(/\/+$/g, "");
  }
  return DEFAULT_BASE_URL;
}

function resolveUserAgent(): string {
  const version = process.env.npm_package_version?.trim();
  return version ? `t3code/${version}` : "t3code";
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown) {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause instanceof Error && cause.message ? cause.message : String(cause),
    cause,
  });
}

function toSessionNotFound(threadId: ThreadId) {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId,
  });
}

function buildMessages(input: ProviderSendTurnInput): CopilotMessage[] {
  const messages: CopilotMessage[] = [];
  for (const entry of input.history ?? []) {
    messages.push({ role: entry.role, content: entry.text });
  }
  if (input.input) {
    messages.push({ role: "user", content: input.input });
  }
  return messages;
}

const makeCopilotAdapter = Effect.gen(function* () {
  const authStore = yield* CopilotAuthStore;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, ProviderSession>();
  const abortControllers = new Map<ThreadId, AbortController>();

  const emit = (event: ProviderRuntimeEvent) => {
    void Effect.runPromise(Queue.offer(runtimeEventQueue, event));
  };

  const makeEventBase = (threadId: ThreadId, turnId?: TurnId) =>
    ({
      eventId: toEventId(),
      provider: PROVIDER,
      threadId,
      createdAt: nowIso(),
      ...(turnId ? { turnId } : {}),
    }) satisfies Omit<ProviderRuntimeEvent, "type" | "payload">;

  const updateSession = (threadId: ThreadId, patch: Partial<ProviderSession>) => {
    const session = sessions.get(threadId);
    if (!session) return;
    sessions.set(threadId, { ...session, ...patch, updatedAt: nowIso() });
  };

  const startSession: CopilotAdapterShape["startSession"] = (input) => {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        }),
      );
    }

    const createdAt = nowIso();
    const normalizedSessionModel =
      input.model && VALID_COPILOT_MODELS.has(input.model)
        ? input.model
        : DEFAULT_MODEL_BY_PROVIDER[PROVIDER];
    const session: ProviderSession = {
      provider: PROVIDER,
      status: "ready",
      runtimeMode: input.runtimeMode,
      cwd: input.cwd,
      model: normalizedSessionModel,
      threadId: input.threadId,
      resumeCursor: input.resumeCursor,
      activeTurnId: undefined,
      createdAt,
      updatedAt: createdAt,
    };

    sessions.set(input.threadId, session);

    emit({
      ...makeEventBase(input.threadId),
      type: "session.started",
      payload: {},
    });
    emit({
      ...makeEventBase(input.threadId),
      type: "session.state.changed",
      payload: {
        state: "ready",
      },
    });

    return Effect.succeed(session);
  };

  const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const session = sessions.get(input.threadId);
      if (!session) {
        return yield* toSessionNotFound(input.threadId);
      }

      if (input.attachments && input.attachments.length > 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "GitHub Copilot does not support attachments yet.",
        });
      }

      const tokenOption = yield* authStore.get;
      const token = tokenOption._tag === "Some" ? tokenOption.value : null;
      if (!token) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "chat/completions",
          detail: "GitHub Copilot is not authenticated. Connect in settings first.",
        });
      }

      const turnId = toTurnId();
      const rawModel = input.model ?? session.model ?? DEFAULT_MODEL_BY_PROVIDER[PROVIDER];
      const resolvedModel = VALID_COPILOT_MODELS.has(rawModel)
        ? rawModel
        : DEFAULT_MODEL_BY_PROVIDER[PROVIDER];
      updateSession(input.threadId, {
        status: "running",
        activeTurnId: turnId,
        model: resolvedModel,
      });

      emit({
        ...makeEventBase(input.threadId, turnId),
        type: "turn.started",
        payload: resolvedModel ? { model: resolvedModel } : {},
      });

      const controller = new AbortController();
      abortControllers.set(input.threadId, controller);

      const streamTurn = Effect.tryPromise({
        try: async () => {
          const messages = buildMessages(input);
          const baseUrl = resolveApiBaseUrl();
          const model = resolvedModel;

          const copilotToken = await getCopilotApiToken(token.accessToken);
          if (!copilotToken) {
            throw new Error(
              "Could not obtain a Copilot API token. Re-authenticate with GitHub Copilot in settings.",
            );
          }

          if (session.cwd) {
            messages.unshift({ role: "system", content: buildCopilotSystemPrompt(session.cwd) });
          }

          const MAX_TOOL_ROUNDS = 20;
          let round = 0;
          let lastFinishReason: string | null = null;

          while (round++ < MAX_TOOL_ROUNDS) {
            if (controller.signal.aborted) break;

            const response = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${copilotToken}`,
                "Content-Type": "application/json",
                "User-Agent": resolveUserAgent(),
                ...COPILOT_IDE_HEADERS,
                "Openai-Intent": "conversation-edits",
                "x-initiator": "user",
              },
              body: JSON.stringify({
                model,
                stream: true,
                messages,
                tools: COPILOT_TOOL_DEFINITIONS,
                tool_choice: "auto",
              }),
              signal: controller.signal,
            });

            const responseText = response.ok ? undefined : await response.text();
            if (!response.ok) {
              throw new Error(
                responseText?.trim() ||
                  `Copilot chat request failed with status ${response.status}.`,
              );
            }

            if (!response.body) {
              throw new Error("Copilot chat response did not include a body.");
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let pendingLines: string[] = [];
            let finishReason: string | null = null;
            let shouldStop = false;
            let assistantContent = "";
            const toolCallsAccumulator = new Map<number, CopilotToolCallAccum>();

            const handleData = (data: string) => {
              if (data === "[DONE]") {
                shouldStop = true;
                return;
              }
              let parsed: CopilotStreamChunk;
              try {
                parsed = JSON.parse(data) as CopilotStreamChunk;
              } catch {
                return;
              }
              if (parsed.error) {
                const message =
                  typeof parsed.error === "string" ? parsed.error : parsed.error.message;
                if (message) {
                  throw new Error(message);
                }
              }
              const choices = parsed.choices ?? [];
              for (const choice of choices) {
                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                }
                const delta = choice.delta;
                if (!delta) continue;

                if (delta.content) {
                  assistantContent += delta.content;
                  emit({
                    ...makeEventBase(input.threadId, turnId),
                    type: "content.delta",
                    payload: {
                      streamKind: "assistant_text",
                      delta: delta.content,
                    },
                  });
                }

                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (!toolCallsAccumulator.has(tc.index)) {
                      toolCallsAccumulator.set(tc.index, { id: "", name: "", arguments: "" });
                    }
                    const acc = toolCallsAccumulator.get(tc.index)!;
                    if (tc.id) acc.id = tc.id;
                    if (tc.function?.name) acc.name = tc.function.name;
                    if (tc.function?.arguments) acc.arguments += tc.function.arguments;
                  }
                }
              }
            };

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let newlineIndex = buffer.indexOf("\n");
              while (newlineIndex >= 0) {
                const rawLine = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                const line = rawLine.replace(/\r$/, "");
                if (line.length === 0) {
                  if (pendingLines.length > 0) {
                    const data = pendingLines.join("\n");
                    pendingLines = [];
                    handleData(data.trim());
                    if (shouldStop) break;
                  }
                } else if (line.startsWith("data:")) {
                  pendingLines.push(line.slice(5).trimStart());
                }
                newlineIndex = buffer.indexOf("\n");
              }
              if (shouldStop) break;
            }

            if (pendingLines.length > 0 && !shouldStop) {
              const data = pendingLines.join("\n");
              pendingLines = [];
              handleData(data.trim());
            }

            lastFinishReason = finishReason;

            // Build and append the assistant message for this round
            const toolCalls = [...toolCallsAccumulator.values()].filter((tc) => tc.name);
            messages.push({
              role: "assistant",
              content: assistantContent || null,
              ...(toolCalls.length > 0
                ? {
                    tool_calls: toolCalls.map((tc) => ({
                      id: tc.id,
                      type: "function" as const,
                      function: { name: tc.name, arguments: tc.arguments },
                    })),
                  }
                : {}),
            });

            // If the model did not request tool calls, we're done
            if (finishReason !== "tool_calls" || toolCalls.length === 0) break;

            // Execute each tool call and feed results back
            for (const tc of toolCalls) {
              if (controller.signal.aborted) break;

              const toolItemId = toRuntimeItemId();
              emit({
                ...makeEventBase(input.threadId, turnId),
                type: "item.started",
                itemId: toolItemId,
                payload: {
                  itemType: "dynamic_tool_call",
                  title: tc.name,
                },
              });
              emit({
                ...makeEventBase(input.threadId, turnId),
                type: "tool.progress",
                payload: {
                  toolUseId: tc.id || undefined,
                  toolName: tc.name,
                },
              });

              let args: unknown;
              try {
                args = JSON.parse(tc.arguments);
              } catch {
                args = {};
              }

              const result = await executeCopilotTool(session.cwd ?? ".", tc.name, args);

              // For write_file, additionally emit a file_change item
              if (tc.name === "write_file") {
                const filePath =
                  typeof (args as Record<string, unknown>).path === "string"
                    ? (args as Record<string, unknown>).path
                    : "unknown";
                const fileItemId = toRuntimeItemId();
                emit({
                  ...makeEventBase(input.threadId, turnId),
                  type: "item.started",
                  itemId: fileItemId,
                  payload: {
                    itemType: "file_change",
                    title: filePath as string,
                  },
                });
                emit({
                  ...makeEventBase(input.threadId, turnId),
                  type: "item.completed",
                  itemId: fileItemId,
                  payload: {
                    itemType: "file_change",
                    status: "completed",
                  },
                });
              }

              const resultSummary = (result.slice(0, 120) || `${tc.name} completed`).trim();
              emit({
                ...makeEventBase(input.threadId, turnId),
                type: "item.completed",
                itemId: toolItemId,
                payload: {
                  itemType: "dynamic_tool_call",
                  status: "completed",
                  detail: resultSummary,
                },
              });
              emit({
                ...makeEventBase(input.threadId, turnId),
                type: "tool.summary",
                payload: {
                  summary: resultSummary,
                  precedingToolUseIds: tc.id ? [tc.id] : undefined,
                },
              });

              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: result,
              });
            }
          }

          emit({
            ...makeEventBase(input.threadId, turnId),
            type: "item.completed",
            itemId: toRuntimeItemId(),
            payload: {
              itemType: "assistant_message",
              status: "completed",
            },
          });

          emit({
            ...makeEventBase(input.threadId, turnId),
            type: "turn.completed",
            payload: {
              state: "completed",
              ...(lastFinishReason ? { stopReason: lastFinishReason } : {}),
            },
          });

          updateSession(input.threadId, { status: "ready", activeTurnId: undefined });
          abortControllers.delete(input.threadId);
        },
        catch: (cause) => toRequestError(input.threadId, "chat/completions", cause),
      }).pipe(
        Effect.catch((cause) => {
          const message = cause.message || "Copilot streaming failed.";
          const abortCause =
            Schema.is(ProviderAdapterRequestError)(cause) && cause.cause instanceof Error
              ? cause.cause
              : null;
          emit({
            ...makeEventBase(input.threadId, turnId),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
            },
          });

          emit({
            ...makeEventBase(input.threadId, turnId),
            type: "turn.completed",
            payload: {
              state: abortCause?.name === "AbortError" ? "interrupted" : "failed",
              ...(message ? { errorMessage: message } : {}),
            },
          });

          updateSession(input.threadId, { status: "ready", activeTurnId: undefined });
          abortControllers.delete(input.threadId);
          return Effect.void;
        }),
      );

      void Effect.runPromise(streamTurn);

      const result: ProviderTurnStartResult = {
        threadId: input.threadId,
        turnId,
      };
      return result;
    });

  const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
    Effect.sync(() => {
      const controller = abortControllers.get(threadId);
      if (controller) {
        controller.abort();
      }
    });

  const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
    Effect.sync(() => {
      const controller = abortControllers.get(threadId);
      if (controller) {
        controller.abort();
      }
      abortControllers.delete(threadId);
      sessions.delete(threadId);
    });

  const listSessions: CopilotAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values()));

  const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
    Effect.fail(toRequestError(threadId, "thread/read", new Error("Not supported.")));

  const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
    Effect.fail(toRequestError(threadId, "thread/rollback", new Error("Not supported.")));

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
    threadId,
    _requestId,
    _decision,
  ) =>
    Effect.fail(toRequestError(threadId, "request/respond", new Error("Not supported.")));

  const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
    threadId,
    _requestId,
    _answers,
  ) => Effect.fail(toRequestError(threadId, "user-input/respond", new Error("Not supported.")));

  const stopAll: CopilotAdapterShape["stopAll"] = () =>
    Effect.sync(() => {
      for (const controller of abortControllers.values()) {
        controller.abort();
      }
      abortControllers.clear();
      sessions.clear();
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies CopilotAdapterShape;
});

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter);
