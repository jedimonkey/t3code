#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  DEFAULT_TEXT_GENERATION_MODEL,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../apps/server/src/config.ts";
import * as ProcessRunner from "../../apps/server/src/processRunner.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: DEFAULT_TEXT_GENERATION_MODEL },
  },
});
if (!values.out) throw new Error("Pass --out <directory>.");
const outputDirectory = values.out;
const decodeSettings = Schema.decodeEffect(CodexSettings);
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const cases = [
  {
    id: "handoff-merged-build-pending",
    entries: [
      {
        type: "user_message",
        messageId: "goal",
        text: "Scope the Lambda deploy work. Preserve developer workflows.",
      },
      {
        type: "assistant_message",
        messageId: "proposal",
        text: "Initial idea: grant a new artifact-writing role.",
      },
      {
        type: "user_message",
        messageId: "decision",
        text: "Use the existing role. Do not add permissions. File a handoff and wait for approval to implement.",
      },
      {
        type: "assistant_message",
        messageId: "handoff",
        text: "The handoff merged. I have not implemented the deploy change. Approve implementation to proceed.",
      },
    ],
    rubric:
      "Put approval first. Say the handoff merged according to the agent and implementation is pending. Keep the existing-role decision; omit the superseded new role.",
  },
  {
    id: "reported-success-and-open-question",
    entries: [
      {
        type: "user_message",
        messageId: "goal",
        text: "Ship the importer without deleting existing records. Do not touch the export path.",
      },
      {
        type: "assistant_message",
        messageId: "tests",
        text: "I ran the importer tests and they passed. I did not run the migration in production.",
      },
      {
        type: "user_input_request",
        status: "waiting",
        questions: ["Should the importer skip or replace duplicate records?"],
      },
    ],
    rubric:
      "Put the duplicate-handling decision first. Preserve both constraints. Attribute the test result to the agent. Do not claim production verification.",
  },
] as const;

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settings = yield* decodeSettings({});
    const generation = yield* makeCodexTextGeneration(settings);
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-summary-eval-" });
    const results = yield* Effect.forEach(cases, (fixture) =>
      Effect.gen(function* () {
        const summary = yield* generation.generateThreadSummary({
          cwd,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: values.model },
          projectId: ProjectId.make("summary-eval"),
          context: yield* encode({ previousSummary: null, entries: fixture.entries }),
        });
        const sources = new Set<string>(
          fixture.entries.flatMap((entry) => ("messageId" in entry ? [entry.messageId] : [])),
        );
        return {
          id: fixture.id,
          rubric: fixture.rubric,
          summary,
          invalidSources: [...summary.brief, ...summary.details].flatMap(({ messageId }) =>
            messageId !== null && !sources.has(messageId) ? [messageId] : [],
          ),
        };
      }),
    );
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    yield* fs.writeFileString(path.join(outputDirectory, "results.json"), yield* encode(results));
  }).pipe(
    Effect.provide(
      ProcessRunner.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-summary-eval-state-" }),
        ),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  ),
);
