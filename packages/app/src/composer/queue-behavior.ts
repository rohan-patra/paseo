/**
 * How a send to a running agent should be routed through the daemon's native
 * message queue: "steer" injects into the active run, "followUp" queues the
 * message daemon-side for after the current run.
 */
export type ComposerQueueBehavior = "steer" | "followUp";

export type ComposerSendAction = "send" | "queue";

// Providers whose runtime consumes the daemon-native message queue today. Pi
// steers/queues in-process; other providers keep the app-local queue +
// send-interrupts-run behavior.
const NATIVE_MESSAGE_QUEUE_PROVIDERS: ReadonlySet<string> = new Set(["pi"]);

// COMPAT(agentNativeMessageQueue): optional daemon feature. Older daemons (and
// protocol floors that predate the flag) simply omit it, so read features as a
// plain boolean record instead of depending on the protocol feature type.
export interface AgentNativeQueueServerInfo {
  features?: Record<string, boolean | undefined>;
}

export function daemonSupportsAgentNativeMessageQueue(
  serverInfo: AgentNativeQueueServerInfo | null | undefined,
): boolean {
  return serverInfo?.features?.agentNativeMessageQueue === true;
}

export interface ResolveComposerQueueBehaviorInput {
  provider: string | null;
  isAgentRunning: boolean;
  daemonSupportsNativeQueue: boolean;
  action: ComposerSendAction;
}

/**
 * Decides whether a composer action targeting a running agent should route
 * through the daemon-native message queue, and with which behavior.
 *
 * Returns null when the existing behavior applies instead: app-local queue for
 * the explicit queue action, plain send (which the daemon treats as an
 * interrupt-and-replace) otherwise. Stop is unaffected either way — it always
 * cancels the agent.
 */
export function resolveComposerQueueBehavior(
  input: ResolveComposerQueueBehaviorInput,
): ComposerQueueBehavior | null {
  if (!input.isAgentRunning || !input.daemonSupportsNativeQueue) {
    return null;
  }
  if (input.provider === null || !NATIVE_MESSAGE_QUEUE_PROVIDERS.has(input.provider)) {
    return null;
  }
  return input.action === "queue" ? "followUp" : "steer";
}
