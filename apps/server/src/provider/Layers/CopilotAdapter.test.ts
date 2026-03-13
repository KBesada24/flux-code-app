import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { afterEach, describe, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import type { CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { CopilotAuthStore } from "../Services/CopilotAuthStore.ts";
import { CopilotAdapterLive } from "./CopilotAdapter.ts";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-adapter-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFile(rootDir: string, relativePath: string, contents: string) {
  const absolutePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, "utf8");
}

function makeSseResponse(events: ReadonlyArray<Record<string, unknown>>): Response {
  const body = `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}

async function makeAdapter(cwd: string) {
  const authStoreLayer = Layer.succeed(CopilotAuthStore, {
    get: Effect.succeed(
      Option.some({
        accessToken: "github-oauth-token",
        tokenType: "bearer",
        scopes: ["read:user"],
        acquiredAt: "2026-03-01T00:00:00.000Z",
      }),
    ),
    set: () => Effect.void,
    clear: Effect.void,
    has: Effect.succeed(true),
  });

  const layer = CopilotAdapterLive.pipe(
    Layer.provideMerge(ServerConfig.layerTest(cwd, cwd)),
    Layer.provideMerge(authStoreLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return await Effect.runPromise(Effect.service(CopilotAdapter).pipe(Effect.provide(layer)));
}

function isDynamicToolStart(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "item.started" }> {
  return event.type === "item.started" && event.payload.itemType === "dynamic_tool_call";
}

function isDynamicToolCompletion(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> {
  return event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call";
}

function isFileChangeStart(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "item.started" }> {
  return event.type === "item.started" && event.payload.itemType === "file_change";
}

function isToolSummary(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "tool.summary" }> {
  return event.type === "tool.summary";
}

function isContentDelta(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> {
  return event.type === "content.delta";
}

async function collectEventsThroughTurn(adapter: CopilotAdapterShape): Promise<ProviderRuntimeEvent[]> {
  const events: ProviderRuntimeEvent[] = [];
  const consumer = Effect.runFork(
    Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ),
  );

  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (events.some((event) => event.type === "turn.completed")) {
        return [...events];
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Timed out waiting for turn.completed event.");
  } finally {
    await Effect.runPromise(Fiber.interrupt(consumer));
  }

  return [...events];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("CopilotAdapterLive", () => {
  it("uses the upgraded toolset and completes multi-round streamed tool execution", async () => {
    const cwd = await makeWorkspace();
    await writeFile(cwd, "src/example.ts", "const value = 1;\n");

    const chatRequests: Array<Record<string, unknown>> = [];
    const responses = [
      makeSseResponse([
        {
          choices: [
            {
              delta: {
                content: "Inspecting the workspace. ",
                tool_calls: [
                  {
                    index: 0,
                    id: "tool-call-1",
                    type: "function",
                    function: {
                      name: "glob_files",
                      arguments: "{\"pattern\":\"*.ts\",",
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: "\"path\":\"src\"}",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
      makeSseResponse([
        {
          choices: [
            {
              delta: {
                content: "Applying the edit. ",
                tool_calls: [
                  {
                    index: 0,
                    id: "tool-call-2",
                    type: "function",
                    function: {
                      name: "edit_file",
                      arguments:
                        "{\"path\":\"src/example.ts\",\"old_string\":\"const value = ",
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: "1;\",\"new_string\":\"const value = 2;\"}",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
      makeSseResponse([
        {
          choices: [
            {
              delta: {
                content: "Done.",
              },
              finish_reason: "stop",
            },
          ],
        },
      ]),
    ];

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/copilot_internal/v2/token")) {
        return Response.json({
          token: "copilot-api-token",
          refresh_in: 300,
        });
      }

      if (url.endsWith("/chat/completions")) {
        chatRequests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        const next = responses.shift();
        if (!next) {
          throw new Error("Missing mocked chat completion response.");
        }
        return next;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const adapter = await makeAdapter(cwd);
    const threadId = ThreadId.makeUnsafe("thread-copilot-1");

    await Effect.runPromise(
      adapter.startSession({
        provider: "github-copilot",
        threadId,
        runtimeMode: "full-access",
        cwd,
      }),
    );

    const eventCollection = collectEventsThroughTurn(adapter);
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "Update the value constant to 2.",
        attachments: [],
      }),
    );

    const events = await eventCollection;
    await Effect.runPromise(adapter.stopAll());

    const toolNames = (
      ((chatRequests[0] ?? {}).tools as Array<{ function: { name: string } }>) ?? []
    ).map((tool) => tool.function.name);
    assert.deepEqual(toolNames, [
      "read_file",
      "list_directory",
      "glob_files",
      "grep_content",
      "edit_file",
      "write_file",
    ]);

    const secondRequestMessages = (chatRequests[1]?.messages as Array<Record<string, unknown>>) ?? [];
    const secondRequestToolMessage = secondRequestMessages.find((message) => message.role === "tool");
    assert.equal(secondRequestToolMessage?.tool_call_id, "tool-call-1");
    assert.match(String(secondRequestToolMessage?.content ?? ""), /src\/example\.ts/u);

    const thirdRequestMessages = (chatRequests[2]?.messages as Array<Record<string, unknown>>) ?? [];
    const thirdRequestToolMessage = thirdRequestMessages.findLast(
      (message) => message.role === "tool",
    );
    assert.equal(thirdRequestToolMessage?.tool_call_id, "tool-call-2");
    assert.match(String(thirdRequestToolMessage?.content ?? ""), /<replacements>1<\/replacements>/u);

    const dynamicToolStarts = events.filter(isDynamicToolStart);
    assert.deepEqual(
      dynamicToolStarts.map((event) => event.payload.title),
      ["Search files", "Edit file"],
    );

    const dynamicToolCompletions = events.filter(isDynamicToolCompletion);
    assert.deepEqual(
      dynamicToolCompletions.map((event) => event.payload.detail),
      ["Found 1 matching files", "Edited src/example.ts (1 replacement)"],
    );

    const toolSummaries = events.filter(isToolSummary);
    assert.deepEqual(
      toolSummaries.map((event) => event.payload.summary),
      ["Found 1 matching files", "Edited src/example.ts (1 replacement)"],
    );

    const fileChangeEvents = events.filter(isFileChangeStart);
    assert.deepEqual(
      fileChangeEvents.map((event) => event.payload.title),
      ["src/example.ts"],
    );

    const textDeltas = events
      .filter(isContentDelta)
      .map((event) => event.payload.delta)
      .join("");
    assert.equal(textDeltas, "Inspecting the workspace. Applying the edit. Done.");

    assert.equal(
      await fs.readFile(path.join(cwd, "src/example.ts"), "utf8"),
      "const value = 2;\n",
    );
  });
});
