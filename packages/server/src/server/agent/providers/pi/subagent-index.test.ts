import { describe, expect, test } from "vitest";

import {
  parsePiSubagentLaunchCommand,
  PiSubagentIndex,
  type PiSubagentUpdate,
} from "./subagent-index.js";

function upserts(events: ReturnType<PiSubagentIndex["apply"]>) {
  return events.flatMap((event) =>
    event.type === "provider_subagent" && event.event.type === "upsert" ? [event.event] : [],
  );
}

function timelines(events: ReturnType<PiSubagentIndex["apply"]>) {
  return events.flatMap((event) =>
    event.type === "provider_subagent" && event.event.type === "timeline" ? [event.event] : [],
  );
}

const running: PiSubagentUpdate = {
  id: "auth-research",
  status: "running",
  cwd: "/repo",
  model: { provider: "modal", id: "kimi-k3" },
  effort: "high",
  metrics: { turns: 2, toolCalls: 3, usage: { input: 9_000, output: 3_000 } },
};

describe("Pi provider subagent mapper", () => {
  test("declares a child from its first relayed update", () => {
    const index = new PiSubagentIndex();
    expect(upserts(index.apply(running))).toEqual([
      {
        type: "upsert",
        id: "auth-research",
        title: "auth-research",
        status: "running",
        subtitle: "kimi-k3 (modal) · High · 2 turns · 3 tools · 12k tokens",
        cwd: "/repo",
      },
    ]);
    expect(index.active).toBe(true);
  });

  test("stays silent when the relay republishes an unchanged task", () => {
    const index = new PiSubagentIndex();
    index.apply(running);
    // The subagents extension persists the whole task on every metrics tick, so
    // an unchanged republish must not rewrite the descriptor.
    expect(index.apply(running)).toEqual([]);
    expect(index.apply({ ...running, metrics: { ...running.metrics, turns: 3 } })).toHaveLength(1);
  });

  test("writes only the fields that moved", () => {
    const index = new PiSubagentIndex();
    index.apply(running);
    expect(upserts(index.apply({ ...running, status: "completed" }))).toEqual([
      { type: "upsert", id: "auth-research", title: "auth-research", status: "completed" },
    ]);
  });

  test("attaches the launching Bash call and its task text", () => {
    const index = new PiSubagentIndex();
    index.noteLaunch("auth-research", { toolCallId: "call_7", task: "Trace token refresh." });
    expect(upserts(index.apply(running))[0]).toMatchObject({
      description: "Trace token refresh.",
      toolCallId: "call_7",
    });
  });

  test("maps every terminal task status onto a descriptor status", () => {
    const index = new PiSubagentIndex();
    const statuses = (["completed", "failed", "cancelled", "timed_out", "orphaned"] as const).map(
      (status) => upserts(index.apply({ id: `task-${status}`, status }))[0]?.status,
    );
    expect(statuses).toEqual(["completed", "failed", "canceled", "failed", "failed"]);
  });

  test("keeps a subtitle when a later publish carries no metrics", () => {
    const index = new PiSubagentIndex();
    index.apply(running);
    expect(index.apply({ id: "auth-research", status: "running" })).toEqual([]);
  });

  test("never presents a /btw side question as a child agent", () => {
    const index = new PiSubagentIndex();
    expect(index.apply({ id: "btw_1", kind: "btw", status: "running" })).toEqual([]);
    expect(index.active).toBe(false);
  });

  test("folds child prose into the child timeline", () => {
    const index = new PiSubagentIndex();
    index.apply(running);
    expect(
      timelines(
        index.apply({ ...running, event: { at: 10, kind: "text", summary: "Found the flow." } }),
      ),
    ).toEqual([
      {
        type: "timeline",
        id: "auth-research",
        item: {
          type: "assistant_message",
          text: "Found the flow.",
          messageId: "pi-subagent:auth-research:1",
        },
      },
    ]);
  });

  test("preserves a complete text block and its source message identity", () => {
    const index = new PiSubagentIndex();
    index.apply(running);
    const text = "First the reconciliation tests call `withExternalCall`.";
    const event = {
      at: 15,
      kind: "text",
      summary: text,
      details: { messageId: "auth-research:text:1" },
    };

    expect(timelines(index.apply({ ...running, event }))[0]?.item).toEqual({
      type: "assistant_message",
      text,
      messageId: "pi-subagent:auth-research:auth-research:text:1",
    });
    // Fire-and-forget UI relays can retry. Stable child identity makes replay
    // harmless even when it arrives with a different transport timestamp.
    expect(timelines(index.apply({ ...running, event: { ...event, at: 16 } }))).toEqual([]);
  });

  test("pairs a child tool start and end on one row", () => {
    const index = new PiSubagentIndex();
    index.apply(running);
    const started = timelines(
      index.apply({
        ...running,
        event: {
          at: 20,
          kind: "tool",
          summary: "start: read",
          details: { phase: "start", name: "read", id: "t1", args: { path: "/repo/auth.ts" } },
        },
      }),
    );
    const ended = timelines(
      index.apply({
        ...running,
        event: {
          at: 21,
          kind: "tool",
          summary: "end: read",
          details: { phase: "end", name: "read", id: "t1" },
        },
      }),
    );
    expect(started[0]?.item).toEqual({
      type: "tool_call",
      callId: "pi-subagent:auth-research:tool:t1",
      name: "read",
      status: "running",
      error: null,
      detail: { type: "plain_text", text: "/repo/auth.ts" },
    });
    expect(ended[0]?.item).toMatchObject({
      callId: "pi-subagent:auth-research:tool:t1",
      status: "completed",
    });
  });

  test("reports a failed finish as an error row, a clean one as prose", () => {
    const index = new PiSubagentIndex();
    index.apply(running);
    expect(
      timelines(
        index.apply({
          ...running,
          status: "failed",
          event: {
            at: 30,
            kind: "terminal",
            summary: "Child crashed",
            details: { status: "failed" },
          },
        }),
      )[0]?.item,
    ).toEqual({ type: "error", message: "Child crashed" });

    const clean = new PiSubagentIndex();
    clean.apply(running);
    expect(
      timelines(
        clean.apply({
          ...running,
          status: "completed",
          event: {
            at: 30,
            kind: "terminal",
            summary: "Done",
            details: { status: "completed" },
          },
        }),
      )[0]?.item,
    ).toMatchObject({ type: "assistant_message", text: "Done" });
  });

  test("shows a final summary once when it repeats the child's last message", () => {
    const index = new PiSubagentIndex();
    index.apply(running);
    expect(
      timelines(index.apply({ ...running, event: { at: 60, kind: "text", summary: "OK" } })),
    ).toHaveLength(1);
    // A child that finishes by reporting its result publishes the same text
    // twice: its own last message, then the task's final summary.
    expect(
      timelines(
        index.apply({
          ...running,
          status: "completed",
          event: { at: 61, kind: "terminal", summary: "OK", details: { status: "completed" } },
        }),
      ),
    ).toEqual([]);
  });

  test("drops a replayed event instead of duplicating the row", () => {
    const index = new PiSubagentIndex();
    index.apply(running);
    const event = { at: 40, kind: "text", summary: "Only once." };
    expect(timelines(index.apply({ ...running, event }))).toHaveLength(1);
    expect(
      timelines(index.apply({ ...running, event: { at: 39, kind: "text", summary: "Stale." } })),
    ).toEqual([]);
  });

  test("emits nothing for lifecycle and reasoning events", () => {
    const index = new PiSubagentIndex();
    index.apply(running);
    expect(
      timelines(
        index.apply({ ...running, event: { at: 50, kind: "state", summary: "Task created" } }),
      ),
    ).toEqual([]);
    expect(
      timelines(
        index.apply({ ...running, event: { at: 51, kind: "thinking", summary: "Thinking" } }),
      ),
    ).toEqual([]);
  });

  test("cancels only the children still running", () => {
    const index = new PiSubagentIndex();
    index.apply({ id: "done", status: "completed" });
    index.apply({ id: "live", status: "running" });
    expect(index.terminalizeRunning()).toEqual([
      {
        type: "provider_subagent",
        provider: "pi",
        event: { type: "upsert", id: "live", status: "canceled" },
      },
    ]);
    // Terminalizing is idempotent: a second pass has nothing left to cancel.
    expect(index.terminalizeRunning()).toEqual([]);
  });
});

describe("Pi subagent launcher command parsing", () => {
  test("reads the name and task out of a launch", () => {
    expect(
      parsePiSubagentLaunchCommand(
        'pi --mode rpc --no-session --subagent --background --parent-session s1 --subagent-name auth-research --tools read,grep --task "Trace token refresh."',
      ),
    ).toEqual({ name: "auth-research", task: "Trace token refresh." });
  });

  test("accepts a task supplied by file", () => {
    expect(
      parsePiSubagentLaunchCommand(
        "pi --mode rpc --no-session --subagent --parent-session s1 --subagent-name audit --task-file /tmp/task.md",
      ),
    ).toEqual({ name: "audit" });
  });

  test("ignores management operations, which are not launches", () => {
    expect(
      parsePiSubagentLaunchCommand(
        "pi --mode rpc --no-session --subagent --parent-session s1 --status",
      ),
    ).toBeNull();
    expect(
      parsePiSubagentLaunchCommand(
        'pi --mode rpc --no-session --subagent --parent-session s1 --message audit --task "keep going"',
      ),
    ).toBeNull();
  });

  test("ignores unrelated commands", () => {
    expect(parsePiSubagentLaunchCommand("npm test -- --subagentish")).toBeNull();
    expect(parsePiSubagentLaunchCommand("echo hello")).toBeNull();
  });
});
