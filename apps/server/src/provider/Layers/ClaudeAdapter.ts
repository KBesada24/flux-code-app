import { randomUUID } from "node:crypto";

import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as createClaudeQuery } from "@anthropic-ai/claude-agent-sdk";
import {
  type ChatAttachment,
  type ClaudeReasoningEffort,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  RuntimeRequestId,
  RuntimeTaskId,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getEffectiveClaudeCodeEffort,
  getReasoningEffortOptions,
  resolveReasoningEffortForProvider,
  supportsClaudeUltrathinkKeyword,
} from "@t3tools/shared/model";
import { Effect, FileSystem, Layer, Queue, Scope, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderThreadTurnSnapshot } from "../Services/ProviderAdapter.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";

const PROVIDER = "claudeAgent" as const;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

type CreateQuery = typeof createClaudeQuery;

type QueryPromptEntry = {
  readonly type: "message";
  readonly message: SDKUserMessage;
};

type PendingApproval = {
  readonly requestType: "command_execution_approval" | "file_read_approval" | "file_change_approval";
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
  readonly promise: Promise<ProviderApprovalDecision>;
};

type PendingUserInput = {
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly questionText: string;
  }>;
  readonly resolve: (answers: Record<string, unknown>) => void;
  readonly promise: Promise<Record<string, unknown>>;
};

type ClaudeTurnState = {
  readonly turnId: TurnId;
  assistantText: string;
  assistantCompleted: boolean;
};

type ClaudeTurnSnapshot = ProviderThreadTurnSnapshot;

type ClaudeSessionContext = {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<QueryPromptEntry>;
  readonly query: Query;
  readonly turns: Array<ClaudeTurnSnapshot>;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly pendingUserInputs: Map<string, PendingUserInput>;
  turnState: ClaudeTurnState | undefined;
  stopped: boolean;
  basePermissionMode: PermissionMode | undefined;
  readonly providerSessionId: string;
};

export interface ClaudeAdapterLiveOptions {
  readonly createQuery?: CreateQuery;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toEventId(): EventId {
  return EventId.makeUnsafe(randomUUID());
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown) {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("not found") || normalized.includes("unknown session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readClaudeResumeState(resumeCursor: unknown): { readonly resume?: string } | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const cursor = resumeCursor as Record<string, unknown>;
  const resumeValue =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  if (!resumeValue || !isUuid(resumeValue)) {
    return undefined;
  }
  return { resume: resumeValue };
}

function toPermissionMode(value: string | undefined): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
      return value;
    default:
      return undefined;
  }
}

function createResolvable<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function classifyToolItemType(toolName: string) {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

function classifyRequestType(
  toolName: string,
): PendingApproval["requestType"] {
  const normalized = toolName.toLowerCase();
  if (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  ) {
    return "file_read_approval";
  }
  return classifyToolItemType(toolName) === "command_execution"
    ? "command_execution_approval"
    : "file_change_approval";
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : undefined;
  if (commandValue && commandValue.trim().length > 0) {
    return `${toolName}: ${commandValue.trim().slice(0, 400)}`;
  }
  const serialized = JSON.stringify(input);
  return serialized.length <= 400
    ? `${toolName}: ${serialized}`
    : `${toolName}: ${serialized.slice(0, 397)}...`;
}

function extractAssistantText(message: SDKMessage): string {
  if (message.type !== "assistant") {
    return "";
  }
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const block = entry as Record<string, unknown>;
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("");
}

function extractToolPlan(toolInput: Record<string, unknown>): string | undefined {
  return typeof toolInput.plan === "string" && toolInput.plan.trim().length > 0
    ? toolInput.plan.trim()
    : undefined;
}

function extractDelta(message: SDKMessage): {
  readonly streamKind: "assistant_text" | "reasoning_text";
  readonly delta: string;
} | null {
  if (message.type !== "stream_event") {
    return null;
  }
  const event =
    message.event && typeof message.event === "object"
      ? (message.event as Record<string, unknown>)
      : null;
  if (!event || event.type !== "content_block_delta") {
    return null;
  }
  const delta =
    event.delta && typeof event.delta === "object"
      ? (event.delta as Record<string, unknown>)
      : null;
  if (!delta) {
    return null;
  }
  const text =
    typeof delta.text === "string"
      ? delta.text
      : typeof delta.partial_json === "string"
        ? delta.partial_json
        : "";
  if (text.length === 0) {
    return null;
  }
  const deltaType = typeof delta.type === "string" ? delta.type : "text_delta";
  return {
    streamKind: deltaType.includes("thinking") ? "reasoning_text" : "assistant_text",
    delta: text,
  };
}

function turnStateFromResult(
  result: Extract<SDKMessage, { type: "result" }>,
): "completed" | "failed" | "interrupted" | "cancelled" {
  if (result.subtype === "success") {
    return "completed";
  }
  const errors = Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
  if (
    errors.includes("interrupt") ||
    errors.includes("aborted") ||
    errors.includes("request was aborted")
  ) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function toClaudeQuestionId(value: unknown, index: number): string {
  if (typeof value !== "string") {
    return `claude-question-${index + 1}`;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : `claude-question-${index + 1}`;
}

function normalizeClaudeQuestions(toolInput: Record<string, unknown>): Array<
  UserInputQuestion & { readonly questionText: string }
> {
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  return questions.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const question = entry as Record<string, unknown>;
    if (typeof question.question !== "string" || question.question.trim().length === 0) {
      return [];
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!option || typeof option !== "object") {
            return [];
          }
          const choice = option as Record<string, unknown>;
          if (
            typeof choice.label !== "string" ||
            choice.label.trim().length === 0 ||
            typeof choice.description !== "string" ||
            choice.description.trim().length === 0
          ) {
            return [];
          }
          return [
            {
              label: choice.label,
              description: choice.description,
            },
          ];
        })
      : [];
    if (options.length === 0) {
      return [];
    }
    return [
      {
        id: toClaudeQuestionId(question.header ?? question.question, index),
        header:
          typeof question.header === "string" && question.header.trim().length > 0
            ? question.header
            : `Question ${index + 1}`,
        question: question.question,
        options,
        questionText: question.question,
      },
    ];
  });
}

function buildPromptText(input: ProviderSendTurnInput): string {
  const rawEffort = resolveReasoningEffortForProvider(
    "claudeAgent",
    input.modelOptions?.claudeAgent?.effort ?? null,
  );
  const supportedEfforts = getReasoningEffortOptions("claudeAgent", input.model);
  const effort =
    rawEffort &&
    supportedEfforts.includes(rawEffort) &&
    (rawEffort !== "ultrathink" || supportsClaudeUltrathinkKeyword(input.model))
      ? (rawEffort as ClaudeReasoningEffort)
      : null;
  return applyClaudePromptEffortPrefix(input.input ?? "", effort);
}

function buildClaudeImageBlock(input: { readonly mimeType: string; readonly bytes: Uint8Array }) {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

const makeClaudeAdapter = (
  options?: ClaudeAdapterLiveOptions,
): Effect.Effect<ClaudeAdapterShape, never, FileSystem.FileSystem | ServerConfig | Scope.Scope> =>
  Effect.gen(function* () {
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const createQuery = options?.createQuery ?? createClaudeQuery;
    const sessions = new Map<ThreadId, ClaudeSessionContext>();

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const makeEventBase = (input: {
      readonly threadId: ThreadId;
      readonly turnId?: TurnId | undefined;
      readonly requestId?: string | undefined;
    }) =>
      ({
        eventId: toEventId(),
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt: nowIso(),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.requestId ? { requestId: RuntimeRequestId.makeUnsafe(input.requestId) } : {}),
      }) satisfies Omit<ProviderRuntimeEvent, "type" | "payload">;

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<
      ClaudeSessionContext,
      ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError
    > => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const finalizeAssistantIfNeeded = (context: ClaudeSessionContext) =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState || turnState.assistantCompleted) {
          return;
        }
        turnState.assistantCompleted = true;
        yield* emit({
          ...makeEventBase({
            threadId: context.session.threadId,
            turnId: turnState.turnId,
          }),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(turnState.assistantText.trim().length > 0
              ? { detail: turnState.assistantText.trim() }
              : {}),
          },
        });
      });

    const finishTurn = (input: {
      readonly context: ClaudeSessionContext;
      readonly state: "completed" | "failed" | "interrupted" | "cancelled";
      readonly stopReason?: string | null;
      readonly usage?: unknown;
      readonly modelUsage?: Record<string, unknown>;
      readonly totalCostUsd?: number;
      readonly errorMessage?: string;
    }) =>
      Effect.gen(function* () {
        const { context } = input;
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        yield* finalizeAssistantIfNeeded(context);

        yield* emit({
          ...makeEventBase({
            threadId: context.session.threadId,
            turnId: turnState.turnId,
          }),
          type: "turn.completed",
          payload: {
            state: input.state,
            ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
            ...(input.usage !== undefined ? { usage: input.usage } : {}),
            ...(input.modelUsage !== undefined ? { modelUsage: input.modelUsage } : {}),
            ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
            ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
          },
        });

        context.turns.push({
          id: turnState.turnId,
          items: [],
        });
        context.turnState = undefined;
        context.session = {
          ...context.session,
          status: input.state === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: nowIso(),
          ...(input.state === "failed" && input.errorMessage
            ? { lastError: input.errorMessage }
            : {}),
        };
      });

    const stopSessionInternal = (context: ClaudeSessionContext, emitExitEvent: boolean) =>
      Effect.gen(function* () {
        if (context.stopped) {
          return;
        }
        context.stopped = true;
        for (const [requestId, pending] of context.pendingApprovals) {
          context.pendingApprovals.delete(requestId);
          pending.resolve("cancel");
        }
        for (const [requestId, pending] of context.pendingUserInputs) {
          context.pendingUserInputs.delete(requestId);
          pending.resolve({});
        }
        yield* Queue.shutdown(context.promptQueue);
        yield* Effect.sync(() => {
          context.query.close();
        });
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: nowIso(),
        };
        sessions.delete(context.session.threadId);
        if (!emitExitEvent) {
          return;
        }
        yield* emit({
          ...makeEventBase({ threadId: context.session.threadId }),
          type: "session.exited",
          payload: {
            reason: "Session closed",
            recoverable: true,
            exitKind: "graceful",
          },
        });
      });

    const runSdkStream = (context: ClaudeSessionContext) =>
      Effect.tryPromise({
        try: async () => {
          for await (const message of context.query) {
            if (context.stopped) {
              break;
            }
            if (message.type === "assistant") {
              const assistantText = extractAssistantText(message);
              if (assistantText.length > 0 && context.turnState) {
                context.turnState.assistantText = assistantText;
              }
              continue;
            }

            if (message.type === "stream_event") {
              const delta = extractDelta(message);
              if (delta && context.turnState) {
                context.turnState.assistantText += delta.delta;
                await Effect.runPromise(
                  emit({
                    ...makeEventBase({
                      threadId: context.session.threadId,
                      turnId: context.turnState.turnId,
                    }),
                    type: "content.delta",
                    payload: {
                      streamKind: delta.streamKind,
                      delta: delta.delta,
                    },
                  }),
                );
              }
              continue;
            }

            if (message.type === "tool_progress") {
              await Effect.runPromise(
                emit({
                  ...makeEventBase({
                    threadId: context.session.threadId,
                    turnId: context.turnState?.turnId,
                  }),
                  type: "tool.progress",
                  payload: {
                    toolUseId: message.tool_use_id,
                    toolName: message.tool_name,
                    elapsedSeconds: message.elapsed_time_seconds,
                  },
                }),
              );
              continue;
            }

            if (message.type === "tool_use_summary") {
              await Effect.runPromise(
                emit({
                  ...makeEventBase({
                    threadId: context.session.threadId,
                    turnId: context.turnState?.turnId,
                  }),
                  type: "tool.summary",
                  payload: {
                    summary: message.summary,
                    precedingToolUseIds: message.preceding_tool_use_ids,
                  },
                }),
              );
              continue;
            }

            if (message.type === "system") {
              switch (message.subtype) {
                case "task_started":
                  await Effect.runPromise(
                    emit({
                      ...makeEventBase({
                        threadId: context.session.threadId,
                        turnId: context.turnState?.turnId,
                      }),
                      type: "task.started",
                      payload: {
                        taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                        ...(message.description ? { description: message.description } : {}),
                        ...(message.task_type ? { taskType: message.task_type } : {}),
                      },
                    }),
                  );
                  break;
                case "task_progress":
                  await Effect.runPromise(
                    emit({
                      ...makeEventBase({
                        threadId: context.session.threadId,
                        turnId: context.turnState?.turnId,
                      }),
                      type: "task.progress",
                      payload: {
                        taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                        description: message.description,
                        usage: message.usage,
                        ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
                      },
                    }),
                  );
                  break;
                case "task_notification":
                  await Effect.runPromise(
                    emit({
                      ...makeEventBase({
                        threadId: context.session.threadId,
                        turnId: context.turnState?.turnId,
                      }),
                      type: "task.completed",
                      payload: {
                        taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                        status: message.status,
                        summary: message.summary,
                        usage: message.usage,
                      },
                    }),
                  );
                  break;
                case "files_persisted":
                  await Effect.runPromise(
                    emit({
                      ...makeEventBase({
                        threadId: context.session.threadId,
                        turnId: context.turnState?.turnId,
                      }),
                      type: "files.persisted",
                      payload: {
                        files: message.files.map((entry) => ({
                          filename: entry.filename,
                          fileId: entry.file_id,
                        })),
                        ...(message.failed.length > 0
                          ? {
                              failed: message.failed.map((entry) => ({
                                filename: entry.filename,
                                error: entry.error,
                              })),
                            }
                          : {}),
                      },
                    }),
                  );
                  break;
              }
              continue;
            }

            if (message.type === "auth_status") {
              await Effect.runPromise(
                emit({
                  ...makeEventBase({ threadId: context.session.threadId }),
                  type: "auth.status",
                  payload: {
                    isAuthenticating: message.isAuthenticating,
                    output: message.output,
                    ...(message.error ? { error: message.error } : {}),
                  },
                }),
              );
              continue;
            }

            if (message.type === "rate_limit_event") {
              await Effect.runPromise(
                emit({
                  ...makeEventBase({ threadId: context.session.threadId }),
                  type: "account.rate-limits.updated",
                  payload: {
                    rateLimits: message.rate_limit_info,
                  },
                }),
              );
              continue;
            }

            if (message.type === "result") {
              const state = turnStateFromResult(message);
              const errorMessage =
                message.type === "result" && message.subtype !== "success"
                  ? message.errors.find((entry) => entry.trim().length > 0)
                  : undefined;
              await Effect.runPromise(
                finishTurn({
                  context,
                  state,
                  stopReason: message.stop_reason,
                  usage: message.usage,
                  modelUsage: message.modelUsage,
                  totalCostUsd: message.total_cost_usd,
                  ...(errorMessage ? { errorMessage } : {}),
                }),
              );
            }
          }
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: context.session.threadId,
            detail: toMessage(cause, "Claude runtime stream failed."),
            cause,
          }),
      }).pipe(
        Effect.catch((error: ProviderAdapterProcessError) =>
          Effect.gen(function* () {
            if (context.stopped) {
              return;
            }
            if (context.turnState) {
              yield* finishTurn({
                context,
                state: "failed",
                errorMessage: error.detail,
              });
            }
            context.session = {
              ...context.session,
              status: "error",
              activeTurnId: undefined,
              updatedAt: nowIso(),
              lastError: error.detail,
            };
            yield* emit({
              ...makeEventBase({ threadId: context.session.threadId }),
              type: "runtime.error",
              payload: {
                message: error.detail,
                class: "provider_error",
              },
            });
            yield* emit({
              ...makeEventBase({ threadId: context.session.threadId }),
              type: "session.exited",
              payload: {
                reason: error.detail,
                recoverable: true,
                exitKind: "error",
              },
            });
          }),
        ),
      );

    const startSession: ClaudeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = nowIso();
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const sessionId = resumeState?.resume ?? randomUUID();
        const providerOptions = input.providerOptions?.claudeAgent;
        const promptQueue = yield* Queue.unbounded<QueryPromptEntry>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.map((entry) => entry.message),
          Stream.toAsyncIterable,
        );
        const pendingApprovals = new Map<string, PendingApproval>();
        const pendingUserInputs = new Map<string, PendingUserInput>();
        let context!: ClaudeSessionContext;

        const canUseTool = async (
          toolName: string,
          toolInput: Record<string, unknown>,
          callbackOptions: {
            readonly signal: AbortSignal;
            readonly suggestions?: ReadonlyArray<PermissionUpdate>;
            readonly toolUseID: string;
          },
        ): Promise<PermissionResult> => {
          if (toolName === "AskUserQuestion") {
            const requestId = randomUUID();
            const questions = normalizeClaudeQuestions(toolInput);
            const pending = createResolvable<Record<string, unknown>>();
            pendingUserInputs.set(requestId, {
              questions: questions.map((question) => ({
                id: question.id,
                questionText: question.questionText,
              })),
              ...pending,
            });
            await Effect.runPromise(
              emit({
                ...makeEventBase({
                  threadId: context.session.threadId,
                  turnId: context.turnState?.turnId,
                  requestId,
                }),
                type: "user-input.requested",
                payload: {
                  questions: questions.map(({ questionText: _questionText, ...question }) => question),
                },
              }),
            );
            callbackOptions.signal.addEventListener(
              "abort",
              () => {
                const current = pendingUserInputs.get(requestId);
                if (!current) {
                  return;
                }
                pendingUserInputs.delete(requestId);
                current.resolve({});
              },
              { once: true },
            );
            const answersById = await pending.promise;
            pendingUserInputs.delete(requestId);
            await Effect.runPromise(
              emit({
                ...makeEventBase({
                  threadId: context.session.threadId,
                  turnId: context.turnState?.turnId,
                  requestId,
                }),
                type: "user-input.resolved",
                payload: {
                  answers: answersById,
                },
              }),
            );
            const answersByQuestion = Object.fromEntries(
              questions.flatMap((question) => {
                const answer = answersById[question.id];
                return typeof answer === "string" && answer.trim().length > 0
                  ? [[question.questionText, answer]]
                  : [];
              }),
            );
            return {
              behavior: "allow",
              updatedInput: {
                questions: toolInput.questions,
                answers: answersByQuestion,
              },
            };
          }

          if (toolName === "ExitPlanMode") {
            const planMarkdown = extractToolPlan(toolInput);
            if (planMarkdown && context.turnState) {
              await Effect.runPromise(
                emit({
                  ...makeEventBase({
                    threadId: context.session.threadId,
                    turnId: context.turnState.turnId,
                  }),
                  type: "turn.proposed.completed",
                  payload: {
                    planMarkdown,
                  },
                }),
              );
            }
            return {
              behavior: "deny",
              message:
                "The client captured your proposed plan. Stop here and wait for the user's follow-up.",
            };
          }

          if (input.runtimeMode === "full-access") {
            return {
              behavior: "allow",
              updatedInput: toolInput,
            };
          }

          const requestId = randomUUID();
          const decision = createResolvable<ProviderApprovalDecision>();
          pendingApprovals.set(requestId, {
            requestType: classifyRequestType(toolName),
            ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
            ...decision,
          });
          await Effect.runPromise(
            emit({
              ...makeEventBase({
                threadId: context.session.threadId,
                turnId: context.turnState?.turnId,
                requestId,
              }),
              type: "request.opened",
              payload: {
                requestType: classifyRequestType(toolName),
                detail: summarizeToolRequest(toolName, toolInput),
                args: {
                  toolName,
                  input: toolInput,
                  toolUseId: callbackOptions.toolUseID,
                },
              },
            }),
          );
          callbackOptions.signal.addEventListener(
            "abort",
            () => {
              const current = pendingApprovals.get(requestId);
              if (!current) {
                return;
              }
              pendingApprovals.delete(requestId);
              current.resolve("cancel");
            },
            { once: true },
          );
          const resolvedDecision = await decision.promise;
          const pendingApproval = pendingApprovals.get(requestId);
          pendingApprovals.delete(requestId);
          await Effect.runPromise(
            emit({
              ...makeEventBase({
                threadId: context.session.threadId,
                turnId: context.turnState?.turnId,
                requestId,
              }),
              type: "request.resolved",
              payload: {
                requestType: classifyRequestType(toolName),
                decision: resolvedDecision,
              },
            }),
          );

          if (resolvedDecision === "accept" || resolvedDecision === "acceptForSession") {
            return {
              behavior: "allow",
              updatedInput: toolInput,
              ...(resolvedDecision === "acceptForSession" &&
              pendingApproval?.suggestions &&
              pendingApproval.suggestions.length > 0
                ? { updatedPermissions: [...pendingApproval.suggestions] }
                : {}),
            };
          }

          return {
            behavior: "deny",
            message:
              resolvedDecision === "cancel"
                ? "User cancelled tool execution."
                : "User declined tool execution.",
          };
        };

        const rawEffort = resolveReasoningEffortForProvider(
          "claudeAgent",
          input.modelOptions?.claudeAgent?.effort ?? null,
        );
        const supportedEfforts = getReasoningEffortOptions("claudeAgent", input.model);
        const effectiveEffort =
          rawEffort &&
          supportedEfforts.includes(rawEffort) &&
          (rawEffort !== "ultrathink" || supportsClaudeUltrathinkKeyword(input.model))
            ? getEffectiveClaudeCodeEffort(rawEffort as ClaudeReasoningEffort)
            : null;
        const permissionMode =
          toPermissionMode(providerOptions?.permissionMode) ??
          (input.runtimeMode === "full-access" ? "bypassPermissions" : undefined);

        const query = yield* Effect.try({
          try: () =>
            createQuery({
              prompt,
              options: {
                ...(input.cwd ? { cwd: input.cwd } : {}),
                ...(input.model ? { model: input.model } : {}),
                pathToClaudeCodeExecutable: providerOptions?.binaryPath ?? "claude",
                ...(effectiveEffort ? { effort: effectiveEffort } : {}),
                ...(permissionMode ? { permissionMode } : {}),
                ...(permissionMode === "bypassPermissions"
                  ? { allowDangerouslySkipPermissions: true }
                  : {}),
                ...(providerOptions?.maxThinkingTokens !== undefined
                  ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
                  : {}),
                ...(resumeState?.resume ? { resume: resumeState.resume } : { sessionId }),
                includePartialMessages: true,
                canUseTool,
                env: process.env,
                ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
              },
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start Claude runtime session."),
              cause,
            }),
        });

        context = {
          session: {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.model ? { model: input.model } : {}),
            threadId: input.threadId,
            resumeCursor: {
              threadId: input.threadId,
              resume: resumeState?.resume ?? sessionId,
            },
            createdAt: startedAt,
            updatedAt: startedAt,
          },
          promptQueue,
          query,
          turns: [],
          pendingApprovals,
          pendingUserInputs,
          turnState: undefined,
          stopped: false,
          basePermissionMode: permissionMode,
          providerSessionId: resumeState?.resume ?? sessionId,
        };
        sessions.set(input.threadId, context);

        yield* emit({
          ...makeEventBase({ threadId: input.threadId }),
          type: "session.started",
          payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        });
        yield* emit({
          ...makeEventBase({ threadId: input.threadId }),
          type: "thread.started",
          payload: {
            providerThreadId: context.providerSessionId,
          },
        });
        yield* emit({
          ...makeEventBase({ threadId: input.threadId }),
          type: "session.configured",
          payload: {
            config: {
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(input.model ? { model: input.model } : {}),
              ...(effectiveEffort ? { effort: effectiveEffort } : {}),
              ...(permissionMode ? { permissionMode } : {}),
              ...(providerOptions?.maxThinkingTokens !== undefined
                ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
                : {}),
            },
          },
        });
        yield* emit({
          ...makeEventBase({ threadId: input.threadId }),
          type: "session.state.changed",
          payload: {
            state: "ready",
          },
        });

        void Effect.runFork(runSdkStream(context));
        return { ...context.session };
      });

    const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);

        if (input.model) {
          yield* Effect.tryPromise({
            try: () => context.query.setModel(input.model),
            catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
          });
        }

        if (input.interactionMode === "plan") {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode("plan"),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
        } else if (input.interactionMode === "default") {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode(context.basePermissionMode ?? "default"),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
        }

        const turnId = TurnId.makeUnsafe(randomUUID());
        context.turnState = {
          turnId,
          assistantText: "",
          assistantCompleted: false,
        };
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: nowIso(),
          ...(input.model ? { model: input.model } : {}),
        };

        yield* emit({
          ...makeEventBase({
            threadId: context.session.threadId,
            turnId,
          }),
          type: "turn.started",
          payload: {
            ...(input.model ? { model: input.model } : {}),
            ...(input.modelOptions?.claudeAgent?.effort
              ? { effort: input.modelOptions.claudeAgent.effort }
              : {}),
          },
        });

        const promptText = buildPromptText(input);
        const content: Array<Record<string, unknown>> = [];
        if (promptText.length > 0) {
          content.push({
            type: "text",
            text: promptText,
          });
        }

        for (const attachment of input.attachments ?? []) {
          if (attachment.type !== "image") {
            continue;
          }
          if (!SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
            });
          }
          const attachmentPath = resolveAttachmentPath({
            stateDir: serverConfig.stateDir,
            attachment: attachment as ChatAttachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError((cause) => toRequestError(input.threadId, "turn/readAttachment", cause)),
          );
          content.push(
            buildClaudeImageBlock({
              mimeType: attachment.mimeType,
              bytes,
            }),
          );
        }

        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message: {
            type: "user",
            session_id: "",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content,
            },
          },
        }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

        return {
          threadId: context.session.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => context.query.interrupt(),
          catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
        });
      });

    const respondToRequest: ClaudeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "request/respond",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        context.pendingApprovals.delete(requestId);
        pending.resolve(decision);
      });

    const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input/respond",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        context.pendingUserInputs.delete(requestId);
        pending.resolve(answers);
      });

    const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopSessionInternal(context, true);
      });

    const listSessions: ClaudeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });

    const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return {
          threadId,
          turns: context.turns.slice(),
        };
      });

    const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (numTurns > 0) {
          context.turns.splice(Math.max(0, context.turns.length - numTurns));
        }
        return {
          threadId,
          turns: context.turns.slice(),
        };
      });

    const stopAll: ClaudeAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), (context) => stopSessionInternal(context, true)).pipe(
        Effect.asVoid,
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), (context) => stopSessionInternal(context, false))
        .pipe(Effect.asVoid, Effect.andThen(Queue.shutdown(runtimeEventQueue))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeAdapterShape;
  });

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
