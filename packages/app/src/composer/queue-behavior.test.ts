import { describe, expect, it } from "vitest";
import {
  daemonSupportsAgentNativeMessageQueue,
  resolveComposerMessageDelivery,
} from "./queue-behavior";

describe("daemonSupportsAgentNativeMessageQueue", () => {
  it("returns true only when the daemon advertises the feature", () => {
    expect(
      daemonSupportsAgentNativeMessageQueue({
        features: { agentMessageQueue: true },
      }),
    ).toBe(true);
  });

  it("returns false when the feature is absent, false, or the daemon predates features", () => {
    expect(daemonSupportsAgentNativeMessageQueue({ features: {} })).toBe(false);
    expect(
      daemonSupportsAgentNativeMessageQueue({
        features: { agentMessageQueue: false },
      }),
    ).toBe(false);
    expect(daemonSupportsAgentNativeMessageQueue({ features: undefined })).toBe(false);
    expect(daemonSupportsAgentNativeMessageQueue(null)).toBe(false);
    expect(daemonSupportsAgentNativeMessageQueue(undefined)).toBe(false);
  });
});

describe("resolveComposerMessageDelivery", () => {
  const nativeQueueReady = {
    provider: "pi",
    isAgentRunning: true,
    daemonSupportsNativeQueue: true,
  } as const;

  it("routes a normal send to a running Pi agent as a native steer", () => {
    expect(resolveComposerMessageDelivery({ ...nativeQueueReady, action: "send" })).toBe("steer");
  });

  it("routes the explicit queue action to a running Pi agent as a native follow-up", () => {
    expect(resolveComposerMessageDelivery({ ...nativeQueueReady, action: "queue" })).toBe(
      "follow_up",
    );
  });

  it("returns null when the agent is not running", () => {
    expect(
      resolveComposerMessageDelivery({
        ...nativeQueueReady,
        isAgentRunning: false,
        action: "send",
      }),
    ).toBeNull();
  });

  it("returns null when the daemon lacks the capability", () => {
    expect(
      resolveComposerMessageDelivery({
        ...nativeQueueReady,
        daemonSupportsNativeQueue: false,
        action: "send",
      }),
    ).toBeNull();
    expect(
      resolveComposerMessageDelivery({
        ...nativeQueueReady,
        daemonSupportsNativeQueue: false,
        action: "queue",
      }),
    ).toBeNull();
  });

  it("returns null for non-Pi providers even on a capable daemon", () => {
    expect(
      resolveComposerMessageDelivery({ ...nativeQueueReady, provider: "claude", action: "send" }),
    ).toBeNull();
    expect(
      resolveComposerMessageDelivery({ ...nativeQueueReady, provider: null, action: "queue" }),
    ).toBeNull();
  });
});
