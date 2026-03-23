import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

describe("decider project scripts", () => {
  it("emits empty scripts on project.create", async () => {
    const now = new Date().toISOString();
    const readModel = createEmptyReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.created");
    expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it("propagates scripts in project.meta.update payload", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const readModel = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const scripts = [
      {
        id: "lint",
        name: "Lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ] as const;

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          scripts: Array.from(scripts),
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
    expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
  });

  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("message-user-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          provider: "codex",
          model: "gpt-5.3-codex",
          modelOptions: {
            codex: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    const turnStartEvent = events[1];
    expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
    expect(turnStartEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
    if (turnStartEvent?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(turnStartEvent.payload.assistantDeliveryMode).toBe("buffered");
    expect(turnStartEvent.payload).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: asMessageId("message-user-1"),
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "approval-required",
    });
  });

  it("emits thread.runtime-mode-set from thread.runtime-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.makeUnsafe("cmd-runtime-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single runtime-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.runtime-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
      },
    });
  });

  it("emits thread.interaction-mode-set from thread.interaction-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe("cmd-interaction-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          interactionMode: "plan",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single interaction-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.interaction-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "plan",
      },
    });
  });

  it("accepts a valid source proposed plan reference in the same project", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-source-plan"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-source-plan"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-source-plan"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const withSourceThread = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-source"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-source"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-source"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-source"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          projectId: asProjectId("project-1"),
          title: "Source Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const withTargetThread = await Effect.runPromise(
      projectEvent(withSourceThread, {
        sequence: 3,
        eventId: asEventId("evt-thread-target"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-target"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-target"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-target"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-target"),
          projectId: asProjectId("project-1"),
          title: "Target Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withTargetThread, {
        sequence: 4,
        eventId: asEventId("evt-plan-source"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-source"),
        type: "thread.proposed-plan-upserted",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-plan-source"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-plan-source"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          proposedPlan: {
            id: "plan-1",
            turnId: asTurnId("turn-plan"),
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-source-plan"),
          threadId: ThreadId.makeUnsafe("thread-target"),
          message: {
            messageId: asMessageId("message-user-source-plan"),
            role: "user",
            text: "implement this plan",
            attachments: [],
          },
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-source"),
            planId: "plan-1",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    const turnStartEvent = events[1];
    expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
    if (turnStartEvent?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(turnStartEvent.payload.sourceProposedPlan).toEqual({
      threadId: ThreadId.makeUnsafe("thread-source"),
      planId: "plan-1",
    });
  });

  it("rejects a missing source proposed plan reference", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-missing-plan"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-missing-plan"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-missing-plan"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-missing-plan"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-target"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-missing-plan"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-missing-plan"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-target"),
          projectId: asProjectId("project-1"),
          title: "Target Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-start-missing-plan"),
            threadId: ThreadId.makeUnsafe("thread-target"),
            message: {
              messageId: asMessageId("message-user-missing-plan"),
              role: "user",
              text: "implement this plan",
              attachments: [],
            },
            sourceProposedPlan: {
              threadId: ThreadId.makeUnsafe("thread-target"),
              planId: "missing-plan",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("does not exist on thread");
  });

  it("rejects a source proposed plan reference from another project", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProjects = await Effect.runPromise(
      projectEvent(
        await Effect.runPromise(
          projectEvent(initial, {
            sequence: 1,
            eventId: asEventId("evt-project-a"),
            aggregateKind: "project",
            aggregateId: asProjectId("project-a"),
            type: "project.created",
            occurredAt: now,
            commandId: CommandId.makeUnsafe("cmd-project-a"),
            causationEventId: null,
            correlationId: CommandId.makeUnsafe("cmd-project-a"),
            metadata: {},
            payload: {
              projectId: asProjectId("project-a"),
              title: "Project A",
              workspaceRoot: "/tmp/project-a",
              defaultModel: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
        {
          sequence: 2,
          eventId: asEventId("evt-project-b"),
          aggregateKind: "project",
          aggregateId: asProjectId("project-b"),
          type: "project.created",
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-project-b"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-project-b"),
          metadata: {},
          payload: {
            projectId: asProjectId("project-b"),
            title: "Project B",
            workspaceRoot: "/tmp/project-b",
            defaultModel: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        },
      ),
    );
    const withSourceThread = await Effect.runPromise(
      projectEvent(withProjects, {
        sequence: 3,
        eventId: asEventId("evt-thread-source-other-project"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-source"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-source-other-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-source-other-project"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          projectId: asProjectId("project-a"),
          title: "Source Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const withTargetThread = await Effect.runPromise(
      projectEvent(withSourceThread, {
        sequence: 4,
        eventId: asEventId("evt-thread-target-other-project"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-target"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-target-other-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-target-other-project"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-target"),
          projectId: asProjectId("project-b"),
          title: "Target Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withTargetThread, {
        sequence: 5,
        eventId: asEventId("evt-plan-other-project"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-source"),
        type: "thread.proposed-plan-upserted",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-plan-other-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-plan-other-project"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          proposedPlan: {
            id: "plan-1",
            turnId: asTurnId("turn-plan"),
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-start-cross-project"),
            threadId: ThreadId.makeUnsafe("thread-target"),
            message: {
              messageId: asMessageId("message-user-cross-project"),
              role: "user",
              text: "implement this plan",
              attachments: [],
            },
            sourceProposedPlan: {
              threadId: ThreadId.makeUnsafe("thread-source"),
              planId: "plan-1",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("same project");
  });
});
