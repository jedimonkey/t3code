import { StrictMode, type ReactNode } from "react";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ThreadSummary } from "./ThreadSummary";
import { ThreadRepositorySections } from "./ThreadRepositorySections";
import { useThreadRepositoryPinsStore } from "../../threadRepositoryPinsStore";

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: () => ({ data: null, error: null }) as never,
}));

const threadA: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-a"),
};
const threadB: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-b"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, height: 400 } as const;

function setup() {
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    [Symbol.dispose]: () => anchor.remove(),
  };
}

const popoverOpen = (threadRef: ScopedThreadRef) =>
  selectThreadPanelOpen(
    useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
    threadRef,
    "popover",
  );

function Card({
  threadRef,
  inline,
  fixture,
  rows = 1,
  automationRows = 0,
  serverOverflowRows = 0,
  issueListRows = 0,
  summary,
}: {
  threadRef: ScopedThreadRef;
  inline: boolean;
  fixture: ReturnType<typeof setup>;
  summary?: ReactNode;
  /** Rows of 100px shown at full density. Compact always takes 50px. */
  rows?: number;
  /** Rows of 100px in an automations list shown at full density. */
  automationRows?: number;
  /** Rows of 100px that expanded server lists add, which density ignores. */
  serverOverflowRows?: number;
  /** Rows of 100px that expanded linked issues add, which density ignores. */
  issueListRows?: number;
}) {
  return (
    // The web root renders in StrictMode, which re-runs ref callbacks on every mount.
    <StrictMode>
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          registerTimeline: () => {},
          measureDetailsCard: () => {},
          detailsCardTopInset: 0,
          preferredDetailsCard: placement,
          detailsCardPlacement: inline ? placement : null,
        }}
      >
        <ThreadDetailsCard
          threadRef={threadRef}
          anchor={fixture.anchor}
          handle={fixture.handle}
          contentKey={String(rows)}
          summary={summary}
        >
          {(density) => (
            <>
              <p style={{ height: density === "full" ? rows * 100 : 50 }}>
                Details for {threadRef.threadId}
              </p>
              {density === "full" && automationRows > 0 ? (
                <section data-thread-automations-panel style={{ height: automationRows * 100 }} />
              ) : null}
              {density === "full" && serverOverflowRows > 0 ? (
                <div
                  data-thread-details-server-overflow
                  style={{ height: serverOverflowRows * 100 }}
                />
              ) : null}
              {issueListRows > 0 ? (
                <div data-thread-details-issue-list style={{ height: issueListRows * 100 }} />
              ) : null}
            </>
          )}
        </ThreadDetailsCard>
      </ChatCanvasContext>
    </StrictMode>
  );
}

it("stays open once opened", async () => {
  using fixture = setup();
  await using _screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", true));
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  expect(popoverOpen(threadB)).toBe(true);
});

it("closes a popup left open when the card switches inline, and reopens from the flag", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  const setOpen = (open: boolean) =>
    act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", open));
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();

  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", false);
  await screen.rerender(<Card threadRef={threadB} inline fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await setOpen(false);

  await screen.rerender(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
});

it("does not reopen the popover when the card returns from inline mode", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", true));
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();

  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", false);
  await screen.rerender(<Card threadRef={threadB} inline fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();

  await screen.rerender(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  expect(popoverOpen(threadB)).toBe(false);
});

it("removes the leaving thread's popup on a thread switch", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", true));
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();

  await screen.rerender(<Card threadRef={threadA} inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await expect.element(page.getByText("Details for thread-a")).not.toBeInTheDocument();
});

it("reopens after a normal close", async () => {
  using fixture = setup();
  await using _screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  const setOpen = (open: boolean) =>
    act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", open));
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  await setOpen(false);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
});

it("returns to full density when hidden items make the content fit", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline fixture={fixture} rows={6} />);
  const card = page.getByRole("region", { name: "Thread details" });
  await expect.element(card).toHaveAttribute("data-density", "compact");

  await screen.rerender(<Card threadRef={threadB} inline fixture={fixture} rows={2} />);
  await expect.element(card).toHaveAttribute("data-density", "full");
});

it("keeps full density when many automations make the content tall", async () => {
  using fixture = setup();
  await using _screen = await render(
    <Card threadRef={threadB} inline fixture={fixture} rows={2} automationRows={6} />,
  );
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Thread details" }))
    .toHaveAttribute("data-density", "full");
});

it("stays full while expanded server rows overflow", async () => {
  using fixture = setup();
  await using _screen = await render(
    <Card threadRef={threadB} inline fixture={fixture} rows={2} serverOverflowRows={4} />,
  );
  await expect
    .element(page.getByRole("region", { name: "Thread details" }))
    .toHaveAttribute("data-density", "full");
});

it("stays full while expanded issue rows overflow", async () => {
  using fixture = setup();
  await using _screen = await render(
    <Card threadRef={threadB} inline fixture={fixture} rows={2} issueListRows={6} />,
  );
  await expect
    .element(page.getByRole("region", { name: "Thread details" }))
    .toHaveAttribute("data-density", "full");
});

it("keeps the repository list reachable after Show more expands it", async () => {
  using fixture = setup();
  for (let index = 1; index <= 30; index++) {
    useThreadRepositoryPinsStore
      .getState()
      .pin(threadB, { repositoryPath: `/repos/repo-${index}`, name: `repo-${index}` });
  }
  await using _screen = await render(
    <StrictMode>
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          registerTimeline: () => {},
          measureDetailsCard: () => {},
          detailsCardTopInset: 0,
          preferredDetailsCard: placement,
          detailsCardPlacement: placement,
        }}
      >
        <ThreadDetailsCard
          threadRef={threadB}
          anchor={fixture.anchor}
          handle={fixture.handle}
          contentKey="repositories"
        >
          {(density) =>
            // As ThreadDetailsPanel does, essential density drops the repository section.
            density === "essential" ? null : (
              <ThreadRepositorySections
                environmentId={threadB.environmentId}
                threadId={threadB.threadId}
                projectId={ProjectId.make("project")}
                isServerThread={false}
                threadCwd="/repos"
                taskFolder={null}
                reachesTracked
                onTaskFolderChange={() => {}}
                explainsEmpty={false}
                showActions={false}
              />
            )
          }
        </ThreadDetailsCard>
      </ChatCanvasContext>
    </StrictMode>,
  );
  await page.getByRole("button", { name: "Show 26 more" }).click();

  await expect.element(page.getByRole("button", { name: "Show fewer" })).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Thread details" }))
    .not.toHaveAttribute("data-density", "essential");
});

it("keeps the brief available in a narrow window and opens its context and source", async () => {
  using fixture = setup();
  const source = MessageId.make("deployment-decision");
  const onJump = vi.fn();
  await using _screen = await render(
    <Card
      threadRef={threadA}
      inline={false}
      fixture={fixture}
      summary={
        <ThreadSummary
          thread={threadA}
          canRefresh={false}
          onJump={onJump}
          summary={{
            fingerprint: "fixture",
            status: "ready",
            content: {
              brief: [{ text: "Approve the deployment change.", messageId: source }],
              details: [{ text: "Keep the existing deployment role.", messageId: null }],
            },
          }}
        />
      }
    />,
  );
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadA, "popover", true));
  await expect.element(page.getByRole("heading", { name: "Thread summary" })).toBeVisible();
  await expect.element(page.getByText("Keep the existing deployment role.")).not.toBeVisible();
  await page.getByText("More context").click();
  await expect.element(page.getByText("Keep the existing deployment role.")).toBeVisible();
  await page.getByRole("button", { name: "Approve the deployment change." }).click();
  expect(onJump).toHaveBeenCalledWith(source);
});
