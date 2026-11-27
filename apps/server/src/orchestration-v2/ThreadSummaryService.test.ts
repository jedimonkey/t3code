import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Summaries from "./ThreadSummaryService.ts";
import * as Replay from "./testkit/ProviderReplayHarness.ts";

const threadId = ThreadId.make("summary-thread");
const projectId = ProjectId.make("summary-project");
const sourceId = MessageId.make("summary-source");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const fakeSource = MessageId.make("not-in-this-thread");
const settingsLayer = ServerSettings.layerTest({ automaticThreadSummaries: false });
const replayLayer = Replay.layerWithRegistry(
  { name: "thread-summary" },
  ProviderAdapters.layerFromAdapters([
    {
      instanceId: modelSelection.instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("the test never starts a provider session"),
    },
  ]),
  { databaseLayer: Sqlite.layerMemory, runEffectWorker: false },
);
const threadsLayer = Threads.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      replayLayer,
      settingsLayer,
      Receipts.layer.pipe(Layer.provide(Sqlite.layerMemory)),
    ),
  ),
);

const seed = Effect.fn("ThreadSummaryTest.seed")(function* (active = false) {
  const threads = yield* Threads.ThreadManagementService;
  const events = yield* EventSink.EventSinkV2;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("summary-create"),
    threadId,
    projectId,
    title: "Release notes",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const now = yield* DateTime.now;
  const runId = active ? RunId.make("summary-active-run") : null;
  if (runId !== null) {
    yield* events.write({
      events: [
        {
          type: "run.created",
          id: EventId.make("summary-run-event"),
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId: ProviderThreadId.make("summary-provider-thread"),
            userMessageId: sourceId,
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  }
  return yield* events.write({
    events: [
      {
        type: "turn-item.updated",
        id: EventId.make("summary-item-event"),
        threadId,
        occurredAt: now,
        payload: {
          type: "assistant_message",
          messageId: sourceId,
          id: TurnItemId.make("summary-item"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          title: null,
          status: "completed",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          streaming: false,
          text: "The handoff merged. Implementation is pending.",
        },
      },
    ],
  });
});

function withGenerator(
  generateThreadSummary: TextGeneration.TextGeneration["Service"]["generateThreadSummary"],
) {
  return Summaries.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        settingsLayer,
        replayLayer,
        threadsLayer,
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadSummary }),
      ),
    ),
  );
}

const awaitSummary = Effect.fn("ThreadSummaryTest.awaitSummary")(function* (
  sequence: number,
  status: "ready" | "failed",
) {
  const threads = yield* Threads.ThreadManagementService;
  yield* threads
    .streamStoredEventsFrom({
      threadId,
      afterSequence: sequence,
      eventType: "thread.metadata-updated",
    })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "thread.metadata-updated" &&
          stored.event.payload.runningSummary?.status === status,
      ),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
});

it.effect(
  "persists the brief, drops fabricated source links, and retains the brief after a failed refresh",
  () =>
    Effect.gen(function* () {
      const fail = yield* Deferred.make<void>();
      const layer = withGenerator((input) =>
        Effect.gen(function* () {
          assert.include(input.context, "The handoff merged. Implementation is pending.");
          if (yield* Deferred.isDone(fail)) {
            return yield* new TextGenerationError({
              operation: "generateThreadSummary",
              detail: "Unavailable",
            });
          }
          return {
            brief: [{ text: "Handoff merged. Implementation is pending.", messageId: sourceId }],
            details: [{ text: "The handoff records the scope.", messageId: fakeSource }],
          };
        }),
      );
      yield* Effect.gen(function* () {
        const threads = yield* Threads.ThreadManagementService;
        yield* seed();
        const refresh = (id: string) =>
          threads.dispatch({
            type: "thread.summary.refresh",
            commandId: CommandId.make(id),
            threadId,
          });
        const first = yield* refresh("summary-refresh");
        yield* awaitSummary(first.sequence, "ready");
        const ready = (yield* threads.getThreadRecords(threadId, [])).thread.runningSummary;
        assert.deepEqual(ready?.content, {
          brief: [{ text: "Handoff merged. Implementation is pending.", messageId: sourceId }],
          details: [{ text: "The handoff records the scope.", messageId: null }],
        });

        yield* Deferred.succeed(fail, undefined);
        const second = yield* refresh("summary-refresh-again");
        yield* awaitSummary(second.sequence, "failed");
        const failed = (yield* threads.getThreadRecords(threadId, [])).thread.runningSummary;
        assert.equal(failed?.status, "failed");
        assert.deepEqual(failed?.content, ready?.content);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("waits for the progress interval before summarizing a running turn", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const threads = yield* Threads.ThreadManagementService;
    yield* serverSettings.updateSettings({ automaticThreadSummaries: true });
    const seeded = yield* seed(true);
    const sequence = seeded.at(-1)?.sequence ?? 0;

    yield* TestClock.adjust("2 minutes");
    assert.isNotOk((yield* threads.getThreadRecords(threadId, [])).thread.runningSummary);

    yield* TestClock.adjust("1 minute");
    yield* awaitSummary(sequence, "ready");
    const summary = (yield* threads.getThreadRecords(threadId, [])).thread.runningSummary;
    assert.equal(summary?.content?.brief[0]?.text, "Implementation is pending.");
  }).pipe(
    Effect.provide(
      withGenerator(() =>
        Effect.succeed({
          brief: [{ text: "Implementation is pending.", messageId: sourceId }],
          details: [],
        }),
      ),
    ),
  ),
);

it.effect("never publishes a result superseded by another refresh", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const layer = withGenerator(() =>
      Effect.gen(function* () {
        const first = yield* Deferred.succeed(firstStarted, undefined);
        if (first) yield* Deferred.await(releaseFirst);
        return {
          brief: [{ text: first ? "Obsolete result" : "Current result", messageId: sourceId }],
          details: [],
        };
      }),
    );
    yield* Effect.gen(function* () {
      const threads = yield* Threads.ThreadManagementService;
      yield* seed();
      const refresh = (id: string) =>
        threads.dispatch({
          type: "thread.summary.refresh",
          commandId: CommandId.make(id),
          threadId,
        });
      yield* refresh("summary-first");
      yield* Deferred.await(firstStarted);
      const newer = yield* refresh("summary-newer");
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* awaitSummary(newer.sequence, "ready");

      const summary = (yield* threads.getThreadRecords(threadId, [])).thread.runningSummary;
      assert.equal(summary?.content?.brief[0]?.text, "Current result");
    }).pipe(Effect.provide(layer));
  }),
);
