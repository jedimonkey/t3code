import {
  CommandId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadSummaryState,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { useAtomValue } from "@effect/atom-react";
import { uuidv4 } from "../../lib/uuid";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadSummaryModal({
  thread,
  summary,
  canRefresh,
  onClose,
  onJump,
}: {
  thread: ScopedThreadRef;
  summary: ThreadSummaryState | null;
  canRefresh: boolean;
  onClose: () => void;
  onJump: (messageId: MessageId) => void;
}) {
  const gt = useGT();
  const permitted = useAtomValue(
    threadEnvironment.refreshSummary.permissionAtom(thread.environmentId),
  );
  const refresh = useAtomCommand(threadEnvironment.refreshSummary, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const updating = pending || summary?.status === "updating";
  const failed = requestFailed || summary?.status === "failed";
  const status = updating
    ? gt("Updating")
    : failed
      ? gt("Couldn't refresh")
      : summary?.status === "stale" && summary.content !== null
        ? gt("Out of date")
        : null;
  const renderEntries = (entries: NonNullable<ThreadSummaryState["content"]>["brief"]) =>
    [...new Map(entries.map((entry) => [entry.text, entry])).values()].map(
      ({ text, messageId }) => (
        <View key={text} className="flex-row items-baseline gap-2">
          <Text importantForAccessibility="no" className="text-foreground-muted">
            •
          </Text>
          {messageId === null ? (
            <Text className="flex-1 py-2.5 text-foreground">{text}</Text>
          ) : (
            <Pressable
              accessibilityRole="link"
              className="min-h-11 flex-1 justify-center py-2.5"
              onPress={() => onJump(messageId)}
            >
              <Text className="text-primary-text underline">{text}</Text>
            </Pressable>
          )}
        </View>
      ),
    );
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView className="flex-1 bg-sheet">
          <SheetHeader presentation="inline" title={gt("Thread summary")} onClose={onClose} />
          <ScrollView className="flex-1" contentContainerClassName="gap-3 px-5 pb-5">
            {status && (
              <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                {status}
              </Text>
            )}
            {summary?.content ? (
              <>
                <View>{renderEntries(summary.content.brief)}</View>
                {summary.content.details.length > 0 && (
                  <Button
                    tone="text"
                    label={expanded ? gt("Less context") : gt("More context")}
                    onPress={() => setExpanded(!expanded)}
                  />
                )}
                {expanded && <View>{renderEntries(summary.content.details)}</View>}
              </>
            ) : (
              !status && <Text className="text-foreground-muted">{gt("No summary yet.")}</Text>
            )}
            {canRefresh && permitted && (
              <Button
                label={failed ? gt("Retry summary") : gt("Refresh summary")}
                loading={updating}
                onPress={async () => {
                  setPending(true);
                  setRequestFailed(false);
                  const result = await refresh({
                    environmentId: thread.environmentId,
                    input: {
                      type: "thread.summary.refresh",
                      threadId: thread.threadId,
                      commandId: CommandId.make(uuidv4()),
                    },
                  });
                  setPending(false);
                  setRequestFailed(result._tag !== "Success");
                }}
              />
            )}
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}
