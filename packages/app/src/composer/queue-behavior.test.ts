import { describe, expect, it } from "vitest";
import {
  daemonSupportsAgentNativeMessageQueue,
  resolveComposerQueueBehavior,
} from "./queue-behavior";

describe("daemonSupportsAgentNativeMessageQueue", () => {
  it("returns true only when the daemon advertises the feature", () => {
    expect(
      daemonSupportsAgentNativeMessageQueue({
        features: { agentNativeMessageQueue: true },
      }),
    ).toBe(true);
  });

  it("returns false when the feature is absent, false, or the daemon predates features", () => {
    expect(daemonSupportsAgentNativeMessageQueue({ features: {} })).toBe(false);
    expect(
      daemonSupportsAgentNativeMessageQueue({
        features: { agentNativeMessageQueue: false },
      }),
    ).toBe(false);
    expect(daemonSupportsAgentNativeMessageQueue({ features: undefined })).toBe(false);
    expect(daemonSupportsAgentNativeMessageQueue(null)).toBe(false);
    expect(daemonSupportsAgentNativeMessageQueue(undefined)).toBe(false);
  });
});

describe("resolveComposerQueueBehavior", () => {
  const nativeQueueReady = {
    provider: "pi",
    isAgentRunning: true,
    daemonSupportsNativeQueue: true,
  } as const;

  it("routes a normal send to a running Pi agent as a native steer", () => {
    expect(resolveComposerQueueBehavior({ ...nativeQueueReady, action: "send" })).toBe("steer");
  });

  it("routes the explicit queue action to a running Pi agent as a native follow-up", () => {
    expect(resolveComposerQueueBehavior({ ...nativeQueueReady, action: "queue" })).toBe("followUp");
  });

  it("returns null when the agent is not running", () => {
    expect(
      resolveComposerQueueBehavior({ ...nativeQueueReady, isAgentRunning: false, action: "send" }),
    ).toBeNull();
  });

  it("returns null when the daemon lacks the capability", () => {
    expect(
      resolveComposerQueueBehavior({
        ...nativeQueueReady,
        daemonSupportsNativeQueue: false,
        action: "send",
      }),
    ).toBeNull();
    expect(
      resolveComposerQueueBehavior({
        ...nativeQueueReady,
        daemonSupportsNativeQueue: false,
        action: "queue",
      }),
    ).toBeNull();
  });

  it("returns null for non-Pi providers even on a capable daemon", () => {
    expect(
      resolveComposerQueueBehavior({ ...nativeQueueReady, provider: "claude", action: "send" }),
    ).toBeNull();
    expect(
      resolveComposerQueueBehavior({ ...nativeQueueReady, provider: null, action: "queue" }),
    ).toBeNull();
  });
});
