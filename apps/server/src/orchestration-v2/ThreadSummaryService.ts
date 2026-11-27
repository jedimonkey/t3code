import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type ThreadSummaryContent,
  type ThreadSummaryState,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Threads from "./ThreadManagementService.ts";

const PROGRESS_INTERVAL = "3 minutes";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class ThreadSummaryService extends Context.Service<
  ThreadSummaryService,
  { readonly opened: (threadId: ThreadId) => Effect.Effect<void> }
>()("t3/orchestration-v2/ThreadSummaryService") {}

function evidence(item: OrchestrationV2TurnItem) {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      if (item.type === "assistant_message" && item.streaming) return undefined;
      return { type: item.type, messageId: item.messageId, text: item.text.slice(0, 1_600) };
    case "command_execution":
      return item.exitCode === undefined
        ? undefined
        : { type: item.type, title: (item.title ?? "").slice(0, 160), exitCode: item.exitCode };
    case "user_input_request":
      return {
        type: item.type,
        status: item.status,
        questions: item.questions.slice(0, 4).map((question) => question.question.slice(0, 240)),
      };
    case "approval_request":
      return { type: item.type, status: item.status, kind: item.requestKind };
    case "dynamic_tool":
      return item.status === "completed" || item.status === "failed"
        ? { type: item.type, title: (item.title ?? "").slice(0, 160), status: item.status }
        : undefined;
    case "file_change":
      return { type: item.type, file: item.fileName.slice(0, 200), status: item.status };
    default:
      return undefined;
  }
}

function constrainSources(content: ThreadSummaryContent, sources: ReadonlySet<string>) {
  const check = ({ text, messageId }: ThreadSummaryContent["brief"][number]) => ({
    text,
    messageId: messageId !== null && sources.has(messageId) ? messageId : null,
  });
  return { brief: content.brief.map(check), details: content.details.map(check) };
}

const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const generator = yield* TextGeneration.TextGeneration;
  const fs = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const scope = yield* Scope.Scope;
  const concurrency = yield* Semaphore.make(2);
  const running = new Set<ThreadId>();
  const queued = new Set<ThreadId>();
  const settledDuringManual = new Set<ThreadId>();
  const progress = new Set<ThreadId>();

  const readThread = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, []).pipe(Effect.map(({ thread }) => thread));

  const save = Effect.fn("ThreadSummaryService.save")(function* (
    threadId: ThreadId,
    expectedRequestId: CommandId | null,
    summary: ThreadSummaryState,
  ) {
    return yield* threads.dispatch({
      type: "thread.summary.update",
      threadId,
      commandId: CommandId.make(yield* random.uuidV4()),
      expectedRequestId,
      summary,
    });
  });

  const drain = Effect.fn("ThreadSummaryService.drain")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<void> {
    if (running.has(threadId)) {
      queued.add(threadId);
      return;
    }
    running.add(threadId);
    yield* Effect.gen(function* () {
      do {
        queued.delete(threadId);
        yield* concurrency
          .withPermits(1)(
            Effect.gen(function* () {
              const thread = yield* readThread(threadId);
              const state = thread.runningSummary;
              if (
                thread.deletedAt !== null ||
                state?.status !== "updating" ||
                state.requestId === undefined
              )
                return;
              const { requestId, automatic: _automatic, ...saved } = state;
              const enabled = (yield* settings.getSettings).automaticThreadSummaries;
              if (state.automatic && (!enabled || thread.archivedAt !== null)) {
                yield* save(threadId, requestId, { ...saved, requestId, status: "stale" });
                return;
              }
              const result = yield* Effect.gen(function* () {
                const [head, tail, activity] = yield* Effect.all([
                  threads.getTimelinePage(threadId, { limit: 1, view: "messages" }),
                  threads.getTimelinePage(threadId, {
                    limit: 24,
                    beforePosition: Infinity,
                    view: "messages",
                  }),
                  threads.getTimelinePage(threadId, {
                    limit: 20,
                    beforePosition: Infinity,
                    view: "activity",
                  }),
                ]);
                const rows = new Map(
                  [...head.items, ...tail.items, ...activity.items].map((row) => [
                    row.sourceItemId,
                    row,
                  ]),
                );
                const entries = [...rows.values()]
                  .sort((a, b) => a.position - b.position)
                  .flatMap(({ item }) => {
                    const entry = evidence(item);
                    return entry === undefined ? [] : [entry];
                  });
                if (!entries.some((entry) => "messageId" in entry))
                  return { ...saved, status: "stale" as const };
                const entryJson = yield* encodeJson(entries);
                const fingerprint = Hex.encode(
                  yield* digest.digest(Digest.sha256, new TextEncoder().encode(entryJson)),
                );
                if (
                  state.automatic &&
                  fingerprint === state.fingerprint &&
                  state.content !== null
                ) {
                  return { ...saved, status: "ready" as const };
                }
                const modelSelection = resolveProjectSettings(
                  yield* settings.getSettings,
                  thread.projectId,
                ).settings.textGenerationModelSelection;
                const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-summary-" });
                const content = yield* generator.generateThreadSummary({
                  cwd,
                  modelSelection,
                  projectId: thread.projectId,
                  context: yield* encodeJson({ previousSummary: state.content, entries }),
                });
                const sources = new Set(
                  entries.flatMap((entry) => ("messageId" in entry ? [entry.messageId] : [])),
                );
                return {
                  content: constrainSources(content, sources),
                  fingerprint,
                  status: "ready" as const,
                };
              }).pipe(
                Effect.scoped,
                Effect.orElseSucceed(() => ({ ...saved, status: "failed" as const })),
              );
              const current = yield* readThread(threadId);
              const discard =
                state.automatic &&
                (current.archivedAt !== null ||
                  !(yield* settings.getSettings).automaticThreadSummaries);
              yield* save(threadId, requestId, {
                ...(discard ? { ...saved, status: "stale" as const } : result),
                requestId,
              });
              if (settledDuringManual.delete(threadId)) yield* refresh(threadId, "settled");
            }),
          )
          .pipe(Effect.ignoreCause({ log: true }));
      } while (queued.has(threadId));
    }).pipe(Effect.ensuring(Effect.sync(() => running.delete(threadId))));
  });

  const launch = (threadId: ThreadId) => drain(threadId).pipe(Effect.forkIn(scope), Effect.asVoid);

  const refresh = Effect.fn("ThreadSummaryService.refresh")(function* (
    threadId: ThreadId,
    reason: "open" | "settled" | "progress",
  ) {
    const thread = yield* readThread(threadId);
    if (thread.deletedAt !== null) return;
    const current = thread.runningSummary;
    if (current?.status === "updating" && !current.automatic) {
      if (reason === "settled") settledDuringManual.add(threadId);
      if (reason === "open" && !running.has(threadId)) yield* launch(threadId);
      return;
    }
    if (thread.archivedAt !== null) return;
    if (
      reason === "open" &&
      (current?.status === "ready" || current?.status === "failed") &&
      current.content !== null
    )
      return;
    const enabled = (yield* settings.getSettings).automaticThreadSummaries;
    if (!enabled) {
      if (current?.status === "ready" && reason !== "open") {
        yield* save(threadId, current.requestId ?? null, { ...current, status: "stale" });
      } else if (current?.status === "updating" && !running.has(threadId)) {
        yield* launch(threadId);
      }
      return;
    }
    if (reason !== "settled") {
      const shell = yield* threads.getThreadShell(threadId);
      if (
        !shell ||
        (reason === "progress" ? shell.activeRunId === null : shell.visibleItemCount === 0)
      )
        return;
    }
    if (reason === "open" && current?.status === "updating") {
      if (!running.has(threadId)) yield* launch(threadId);
      return;
    }
    yield* save(threadId, current?.requestId ?? null, {
      content: current?.content ?? null,
      fingerprint: current?.fingerprint ?? null,
      status: "updating",
      requestId: CommandId.make(yield* random.uuidV4()),
      automatic: true,
    });
  });

  const schedule = Effect.fn("ThreadSummaryService.schedule")(function* (threadId: ThreadId) {
    if (progress.has(threadId)) return;
    progress.add(threadId);
    yield* Effect.gen(function* () {
      const thread = yield* readThread(threadId);
      const current = thread.runningSummary;
      if (current?.status === "ready" && thread.archivedAt === null) {
        yield* save(threadId, current.requestId ?? null, { ...current, status: "stale" });
      }
      if (!(yield* settings.getSettings).automaticThreadSummaries || thread.archivedAt !== null)
        return;
      yield* Effect.sleep(PROGRESS_INTERVAL);
      yield* refresh(threadId, "progress");
    }).pipe(
      Effect.ensuring(Effect.sync(() => progress.delete(threadId))),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(scope),
    );
  });

  const onEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.metadata-updated":
        return event.payload.runningSummary?.status === "updating"
          ? launch(event.threadId)
          : Effect.void;
      case "thread.unarchived":
        return refresh(event.threadId, "open");
      case "run.updated":
        return event.payload.status === "completed" || event.payload.status === "rolled_back"
          ? refresh(event.threadId, "settled")
          : Effect.void;
      case "turn-item.updated":
        if (
          event.payload.type === "user_input_request" ||
          event.payload.type === "approval_request"
        ) {
          return refresh(event.threadId, "settled");
        }
        switch (event.payload.type) {
          case "assistant_message":
            return event.payload.streaming ? Effect.void : schedule(event.threadId);
          case "user_message":
          case "file_change":
            return schedule(event.threadId);
          case "command_execution":
          case "dynamic_tool":
            return event.payload.status === "completed" || event.payload.status === "failed"
              ? schedule(event.threadId)
              : Effect.void;
          default:
            return Effect.void;
        }
      default:
        return Effect.void;
    }
  };

  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach((event) => onEvent(event).pipe(Effect.ignoreCause({ log: true }))),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped({ startImmediately: true }),
  );
  return ThreadSummaryService.of({
    opened: Effect.fn("ThreadSummaryService.opened")(function (threadId) {
      return refresh(threadId, "open").pipe(Effect.ignoreCause({ log: true }));
    }),
  });
});

export const layer = Layer.effect(ThreadSummaryService, make);
