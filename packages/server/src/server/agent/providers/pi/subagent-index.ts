import type { AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";
import type {
  ProviderSubagentInputEvent,
  ProviderSubagentStatus,
} from "../../provider-subagents/store.js";

/**
 * Pi has no subagent RPC.
 *
 * Subagents are not a Pi core feature — they are an extension (`extensions/subagents`
 * in claude-code-proxy) that launches real `pi` child processes through Bash and
 * tracks them in-process. Pi's RPC command set (verified against pi 0.83.0:
 * `{"type":"get_subagents"}` → `"Unknown command: get_subagents"`) exposes none of
 * it, so a daemon-only bridge can never see a subagent. The only supported channel
 * an extension has to an RPC client is `ctx.ui.*`, which is why Paseo's injected
 * `paseo-integration.mjs` relays the extension bus event `subagents:event` as a
 * `PASEO_SUBAGENT` notify marker and this file decodes it.
 *
 * Shape follows `providers/claude/subagents/observation.ts`: the transport is
 * decoded into facts, and facts fold into sticky `provider_subagent` upserts. The
 * one difference is that Pi's source is level-triggered — the extension persists a
 * whole task record on every metrics tick — so descriptor writes are diffed here.
 * Without that, a child running tools would rewrite its descriptor several times a
 * second for no visible change.
 */

/** Task lifecycle states as `extensions/subagents/types.ts` defines them. */
export type PiSubagentTaskStatus =
  | "starting"
  | "running"
  | "waiting_for_parent"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "orphaned";

export interface PiSubagentTaskEvent {
  at?: number;
  kind?: string;
  summary?: string;
  details?: unknown;
}

/**
 * One `subagents:event` bus payload, flattened by the injected extension.
 *
 * Everything except `id` is optional: the relay forwards whatever the running
 * subagents extension published, and older extension builds publish less.
 */
export interface PiSubagentUpdate {
  id: string;
  status?: PiSubagentTaskStatus;
  kind?: string;
  cwd?: string;
  model?: { provider?: string; id?: string };
  effort?: string;
  depth?: number;
  parentTaskId?: string;
  childSessionId?: string;
  childSessionFile?: string;
  createdAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  metrics?: {
    turns?: number;
    toolCalls?: number;
    contextTokens?: number;
    contextWindow?: number;
    thinkingStartedAt?: number;
    currentTool?: { id?: string; name?: string; args?: unknown; startedAt?: number };
    usage?: { input?: number; output?: number; cost?: number };
  };
  final?: { summary?: string; error?: string; stopReason?: string };
  pendingRequest?: { requestId?: string; question?: string; context?: string; options?: string[] };
  /** The single task event that caused this publish, when there was one. */
  event?: PiSubagentTaskEvent;
}

/** What the parent session knows about the Bash call that launched a child. */
export interface PiSubagentLaunch {
  toolCallId: string;
  task?: string;
}

interface PiSubagentState {
  seen: boolean;
  title: string;
  description: string | null;
  subtitle: string | null;
  status: ProviderSubagentStatus;
  toolCallId: string | null;
  cwd: string | null;
  /** Last event timestamp folded into the timeline; guards duplicate replays. */
  lastEventAt: number;
  /** Distinguishes same-millisecond events without provider-assigned identity. */
  eventSequence: number;
  /** Complete child text blocks already appended; relay retries must not duplicate rows. */
  seenMessageIds: Set<string>;
  /** Argument preview from each open child tool call, keyed by the child's call id. */
  openToolDetails: Map<string, string>;
  /** Last prose row emitted, so a final summary that repeats it is not shown twice. */
  lastTimelineText: string;
}

export class PiSubagentIndex {
  private readonly states = new Map<string, PiSubagentState>();
  private readonly launches = new Map<string, PiSubagentLaunch>();

  /**
   * Record the parent Bash call that launched a named child.
   *
   * The bus payload carries no link back to the parent turn and no task text —
   * the subagents extension strips the prompt before publishing. The launcher
   * command line has both, and the daemon already sees it as an ordinary `bash`
   * tool call, so correlating by `--subagent-name` is the only place those two
   * facts exist together.
   */
  noteLaunch(name: string, launch: PiSubagentLaunch): void {
    const key = name.trim();
    if (!key) return;
    const previous = this.launches.get(key);
    this.launches.set(key, {
      toolCallId: launch.toolCallId,
      task: launch.task ?? previous?.task,
    });
  }

  apply(update: PiSubagentUpdate): AgentStreamEvent[] {
    const id = update.id.trim();
    if (!id) return [];
    // `/btw` is a side question answered inline in the parent transcript. It is
    // deliberately never presented as a child agent.
    if (update.kind === "btw") return [];
    const state = this.stateFor(id);
    const events: ProviderSubagentInputEvent[] = [];

    const descriptor = this.diffDescriptor(id, state, update);
    if (descriptor) events.push(descriptor);

    const item = this.consumeEvent(state, update);
    if (item) events.push({ type: "timeline", id, item });

    return events.map((event) => ({ type: "provider_subagent", provider: "pi", event }));
  }

  /**
   * Mark children that were still running as canceled.
   *
   * Called when the Pi process exits or the session closes: those children are
   * separate OS processes the parent extension terminates on shutdown, and a row
   * left "running" against a dead parent never resolves.
   */
  terminalizeRunning(): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    for (const [id, state] of this.states) {
      if (state.status !== "running") continue;
      state.status = "canceled";
      events.push({
        type: "provider_subagent",
        provider: "pi",
        event: { type: "upsert", id, status: "canceled" },
      });
    }
    return events;
  }

  clear(): void {
    this.states.clear();
    this.launches.clear();
  }

  /** True once any subagent update has been decoded, i.e. the structured bridge is live. */
  get active(): boolean {
    return this.states.size > 0;
  }

  private stateFor(id: string): PiSubagentState {
    const existing = this.states.get(id);
    if (existing) return existing;
    const state: PiSubagentState = {
      seen: false,
      title: "",
      description: null,
      subtitle: null,
      status: "running",
      toolCallId: null,
      cwd: null,
      lastEventAt: 0,
      eventSequence: 0,
      seenMessageIds: new Set(),
      openToolDetails: new Map(),
      lastTimelineText: "",
    };
    this.states.set(id, state);
    return state;
  }

  /**
   * Emit an upsert only when a descriptor field actually changed.
   *
   * Sticky store semantics mean an omitted field preserves what is stored, so a
   * partial upsert is safe and a no-op upsert is pure noise. `title` and `status`
   * always ride along: they are two short fields, and carrying identity on every
   * write keeps the event self-describing for anything replaying the stream.
   */
  private diffDescriptor(
    id: string,
    state: PiSubagentState,
    update: PiSubagentUpdate,
  ): ProviderSubagentInputEvent | null {
    const launch = this.launches.get(id);
    const next = {
      title: id,
      description: launch?.task ?? state.description,
      // A publish that carries no metrics yet must not blank a subtitle already
      // shown, so an empty build preserves the previous value.
      subtitle: buildPiSubagentSubtitle(update) ?? state.subtitle,
      status: mapPiSubagentStatus(update.status) ?? state.status,
      toolCallId: launch?.toolCallId ?? state.toolCallId,
      cwd: update.cwd?.trim() || state.cwd,
    };

    const changed =
      !state.seen ||
      next.title !== state.title ||
      next.description !== state.description ||
      next.subtitle !== state.subtitle ||
      next.status !== state.status ||
      next.toolCallId !== state.toolCallId ||
      next.cwd !== state.cwd;
    if (!changed) return null;

    const event: ProviderSubagentInputEvent = {
      type: "upsert",
      id,
      title: next.title,
      status: next.status,
    };
    if (next.description !== state.description) event.description = next.description;
    if (next.subtitle !== state.subtitle) event.subtitle = next.subtitle;
    if (next.toolCallId !== state.toolCallId) event.toolCallId = next.toolCallId;
    if (next.cwd !== state.cwd) event.cwd = next.cwd;
    Object.assign(state, next, { seen: true });
    return event;
  }

  /**
   * Fold the one task event this publish carried into a child timeline item.
   *
   * The relay forwards the newest event only, but the transport is a fire-and-forget
   * notify: a duplicate publish (extension retry, or a replayed marker) must not
   * append the same row twice. `at` plus a monotonic sequence is enough — the
   * subagents extension stamps every event with `Date.now()` in publish order.
   */
  private consumeEvent(state: PiSubagentState, update: PiSubagentUpdate): AgentTimelineItem | null {
    const event = update.event;
    if (!event) return null;
    const at = typeof event.at === "number" ? event.at : 0;
    if (at !== 0 && at < state.lastEventAt) return null;
    const messageId = eventMessageId(event);
    if (messageId && state.seenMessageIds.has(messageId)) return null;
    if (messageId) state.seenMessageIds.add(messageId);
    state.lastEventAt = at;
    state.eventSequence += 1;
    return piSubagentTimelineItem(update.id.trim(), state, event, state.eventSequence, messageId);
  }
}

function mapPiSubagentStatus(
  status: PiSubagentTaskStatus | undefined,
): ProviderSubagentStatus | null {
  if (!status) return null;
  if (status === "completed") return "completed";
  if (status === "cancelled") return "canceled";
  // `orphaned` is "the process is gone but its transcript is on disk" — an
  // outcome the user did not ask for, so it reads as a failure, not a cancel.
  if (status === "failed" || status === "timed_out" || status === "orphaned") return "failed";
  return "running";
}

/**
 * The compact secondary label clients render without parsing, matching the
 * shape Claude's `buildClaudeSubagentSubtitle` produces.
 */
export function buildPiSubagentSubtitle(update: PiSubagentUpdate): string | null {
  const metrics = update.metrics;
  const usage = metrics?.usage;
  const tokens = (usage?.input ?? 0) + (usage?.output ?? 0);
  const parts = [
    formatModel(update.model),
    formatEffort(update.effort),
    metrics?.turns ? `${metrics.turns} ${metrics.turns === 1 ? "turn" : "turns"}` : undefined,
    metrics?.toolCalls
      ? `${metrics.toolCalls} ${metrics.toolCalls === 1 ? "tool" : "tools"}`
      : undefined,
    tokens > 0 ? `${formatTokens(tokens)} tokens` : undefined,
    formatContext(metrics?.contextTokens, metrics?.contextWindow),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatModel(model: PiSubagentUpdate["model"]): string | undefined {
  const id = model?.id?.trim();
  if (!id) return undefined;
  const provider = model?.provider?.trim();
  return provider ? `${id} (${provider})` : id;
}

function formatEffort(effort: string | undefined): string | undefined {
  const normalized = effort?.trim();
  if (!normalized) return undefined;
  if (normalized === "xhigh") return "Extra High";
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatContext(tokens: number | undefined, window: number | undefined): string | undefined {
  if (!tokens || tokens <= 0) return undefined;
  if (!window || window <= 0) return `${formatTokens(tokens)} ctx`;
  const percent = Math.round((tokens / window) * 100);
  // A child that has barely started reads as "0% ctx", which is noise next to
  // the token count that already says the same thing.
  return percent > 0 ? `${percent}% ctx` : undefined;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  return `${Math.round(tokens / 100) / 10}k`;
}

interface PiSubagentToolDetails {
  phase?: string;
  name?: string;
  id?: string;
  args?: unknown;
  isError?: boolean;
  result?: unknown;
}

function eventMessageId(event: PiSubagentTaskEvent): string | undefined {
  if (event.kind !== "text") return undefined;
  const messageId = (event.details as { messageId?: unknown } | undefined)?.messageId;
  return typeof messageId === "string" && messageId.trim() ? messageId.trim() : undefined;
}

function piSubagentTimelineItem(
  id: string,
  state: PiSubagentState,
  event: PiSubagentTaskEvent,
  sequence: number,
  sourceMessageId?: string,
): AgentTimelineItem | null {
  const summary = event.summary?.trim();
  switch (event.kind) {
    // Every one of these is child-authored prose — model output, a
    // `send_parent_update`, an `ask_parent` question, or the final summary — so
    // they render as assistant messages inside the child's own pane. They are
    // never merged into the parent's reasoning.
    case "text":
    case "progress":
    case "question": {
      if (!summary) return null;
      state.lastTimelineText = summary;
      return {
        type: "assistant_message",
        text: summary,
        messageId: `pi-subagent:${id}:${sourceMessageId ?? sequence}`,
      };
    }
    case "terminal": {
      if (!summary) return null;
      const status = (event.details as { status?: string } | undefined)?.status;
      if (status && status !== "completed") return { type: "error", message: summary };
      // A child that finishes by reporting its result emits that text twice:
      // once as its own last message, once as the task's final summary. Showing
      // both puts the same paragraph on screen back to back.
      if (summary === state.lastTimelineText) return null;
      state.lastTimelineText = summary;
      return {
        type: "assistant_message",
        text: summary,
        messageId: `pi-subagent:${id}:${sequence}`,
      };
    }
    case "tool":
      return piSubagentToolItem(id, state, event, sequence);
    // `thinking` carries no reasoning text — the subagents extension deliberately
    // retains none — and `state` is lifecycle already expressed by the descriptor
    // status. Neither earns a transcript row.
    default:
      return null;
  }
}

function piSubagentToolItem(
  id: string,
  state: PiSubagentState,
  event: PiSubagentTaskEvent,
  sequence: number,
): AgentTimelineItem | null {
  const details = (event.details ?? {}) as PiSubagentToolDetails;
  const name = details.name?.trim() || event.summary?.trim() || "tool";
  // A child tool call is identified by the child's own call id when it has one,
  // so `start` and `end` land on the same row instead of stacking two.
  const callId = details.id
    ? `pi-subagent:${id}:tool:${details.id}`
    : `pi-subagent:${id}:tool:${sequence}`;
  const running = details.phase === "start";
  // Only the `start` frame carries arguments. Carrying its preview onto the
  // matching `end` keeps a finished row saying what it acted on instead of
  // collapsing to a bare tool name.
  const text = summarizeToolArgs(details.args) || state.openToolDetails.get(callId) || name;
  if (running) state.openToolDetails.set(callId, text);
  else state.openToolDetails.delete(callId);
  const detail = { type: "plain_text" as const, text };
  if (running) return { type: "tool_call", callId, name, status: "running", error: null, detail };
  if (details.isError) {
    return {
      type: "tool_call",
      callId,
      name,
      status: "failed",
      error: summarizeToolArgs(details.result) || "Tool call failed",
      detail,
    };
  }
  return { type: "tool_call", callId, name, status: "completed", error: null, detail };
}

/**
 * Argument keys that identify what a tool call acted on, most specific first.
 * Picking by key rather than by length matters: an edit's longest string
 * argument is its replacement text, so a length heuristic shows new file
 * contents where the reader expects a path.
 */
const TOOL_PREVIEW_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "task",
  "prompt",
];
const MAX_TOOL_PREVIEW_CHARS = 200;

function summarizeToolArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return bound(args);
  if (typeof args !== "object" || Array.isArray(args)) return bound(String(args));
  const record = args as Record<string, unknown>;
  const keyed = TOOL_PREVIEW_KEYS.find(
    (key) => typeof record[key] === "string" && (record[key] as string).length > 0,
  );
  if (keyed) return bound(record[keyed] as string);
  try {
    return bound(JSON.stringify(args) ?? "");
  } catch {
    return "";
  }
}

function bound(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= MAX_TOOL_PREVIEW_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_TOOL_PREVIEW_CHARS)}…`;
}

const SUBAGENT_LAUNCH_MARKER = /(^|\s)--subagent(\s|$)/;
const SUBAGENT_NAME_FLAG = /--subagent-name[\s=]+("([^"]+)"|'([^']+)'|(\S+))/;
const SUBAGENT_TASK_FLAG = /--task[\s=]+("([^"]*)"|'([^']*)'|(\S+))/;

/**
 * Read the launcher facts out of a parent `bash` command line.
 *
 * `extensions/subagents` instructs the model to launch children with
 * `pi --mode rpc --no-session --subagent --parent-session <id> --subagent-name <name> --task "..."`,
 * so this is the parent-side half of the correlation. Management operations
 * (`--status`, `--await`, `--cancel`, …) share the `--subagent` prefix but are not
 * launches; they are rejected by requiring a task payload.
 */
export function parsePiSubagentLaunchCommand(
  command: string,
): { name: string; task?: string } | null {
  if (!SUBAGENT_LAUNCH_MARKER.test(command)) return null;
  const nameMatch = command.match(SUBAGENT_NAME_FLAG);
  const name = nameMatch ? (nameMatch[2] ?? nameMatch[3] ?? nameMatch[4] ?? "") : "";
  if (!name) return null;
  const taskMatch = command.match(SUBAGENT_TASK_FLAG);
  const task = taskMatch ? (taskMatch[2] ?? taskMatch[3] ?? taskMatch[4] ?? "") : "";
  // The task payload is model-authored prose that can contain anything, so the
  // management-flag check runs against the command line with it removed.
  const flags = taskMatch ? command.replace(taskMatch[0], "") : command;
  if (/--(status|await|cancel|transcript|respond|message)\b/.test(flags)) return null;
  if (!task && !/--task-file\b/.test(flags)) return null;
  return task ? { name, task: bound(task) } : { name };
}
