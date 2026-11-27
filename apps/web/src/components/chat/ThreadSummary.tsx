import {
  CommandId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadSummaryState,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function ThreadSummary({
  thread,
  summary,
  canRefresh,
  onJump,
}: {
  thread: ScopedThreadRef;
  summary: ThreadSummaryState | null;
  canRefresh: boolean;
  onJump: (messageId: MessageId) => void;
}) {
  const gt = useGT();
  const permitted = useAtomValue(
    threadEnvironment.refreshSummary.permissionAtom(thread.environmentId),
  );
  const refresh = useAtomCommand(threadEnvironment.refreshSummary, { reportFailure: false });
  const [requestFailed, setRequestFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const updating = pending || summary?.status === "updating";
  const failed = requestFailed || summary?.status === "failed";
  const status = updating
    ? gt("Updating")
    : failed
      ? gt("Couldn't refresh")
      : summary?.status === "stale" && summary.content !== null
        ? gt("Out of date")
        : null;

  const renderEntries = (entries: NonNullable<ThreadSummaryState["content"]>["brief"]) => (
    <ul className="space-y-1.5 pl-4 text-xs leading-relaxed marker:text-muted-foreground">
      {[...new Map(entries.map((entry) => [entry.text, entry])).values()].map(
        ({ text, messageId }) => (
          <li className="list-disc" key={text}>
            {messageId === null ? (
              text
            ) : (
              <button
                type="button"
                className="text-left underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-current"
                onClick={() => onJump(messageId)}
              >
                {text}
              </button>
            )}
          </li>
        ),
      )}
    </ul>
  );

  return (
    <section aria-label={gt("Thread summary")} className="px-3 py-2.5">
      <div className="flex min-h-7 items-center gap-2">
        <h2 className="flex-1 text-xs font-medium">
          <T>Thread summary</T>
        </h2>
        {status && (
          <span role="status" className="text-xs text-muted-foreground">
            {status}
          </span>
        )}
        {canRefresh && permitted && (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={failed ? gt("Retry summary") : gt("Refresh summary")}
            disabled={updating}
            onClick={async () => {
              setRequestFailed(false);
              setPending(true);
              const result = await refresh({
                environmentId: thread.environmentId,
                input: {
                  type: "thread.summary.refresh",
                  threadId: thread.threadId,
                  commandId: CommandId.make(randomUUID()),
                },
              });
              setPending(false);
              setRequestFailed(result._tag !== "Success");
            }}
          >
            <RotateCwIcon />
          </Button>
        )}
      </div>
      {summary?.content ? (
        <>
          {renderEntries(summary.content.brief)}
          {summary.content.details.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                <T>More context</T>
              </summary>
              <div className="mt-2">{renderEntries(summary.content.details)}</div>
            </details>
          )}
        </>
      ) : !updating && !failed ? (
        <p className="text-xs text-muted-foreground">
          <T>No summary yet.</T>
        </p>
      ) : null}
    </section>
  );
}
