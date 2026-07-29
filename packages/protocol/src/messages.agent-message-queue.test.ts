import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  AgentMessageQueueProjectionSchema,
  SendAgentMessageSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

// COMPAT(agentMessageQueue): frozen at the pre-v0.2.4 wire shapes so both
// directions of the protocol contract stay covered while the gate exists.
const PreviousSendAgentMessageRequestSchema = z.object({
  type: z.literal("send_agent_message_request"),
  requestId: z.string(),
  agentId: z.string(),
  text: z.string(),
  messageId: z.string().optional(),
});

const PreviousSendAgentMessageResponseSchema = z.object({
  type: z.literal("send_agent_message_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});

describe("agent message queue wire compatibility", () => {
  test("legacy send requests without delivery still parse", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "send_agent_message_request",
      requestId: "req-1",
      agentId: "agent-1",
      text: "hello",
    });
    expect(parsed).toMatchObject({
      type: "send_agent_message_request",
      agentId: "agent-1",
      text: "hello",
    });
    expect("delivery" in parsed).toBe(false);
  });

  test("send requests carry an explicit steer or follow_up delivery", () => {
    for (const delivery of ["steer", "follow_up"] as const) {
      const parsed = SessionInboundMessageSchema.parse({
        type: "send_agent_message_request",
        requestId: "req-1",
        agentId: "agent-1",
        text: "hello",
        delivery,
      });
      expect(parsed).toMatchObject({ delivery });
    }
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "send_agent_message_request",
        requestId: "req-1",
        agentId: "agent-1",
        text: "hello",
        delivery: "interrupt",
      }).success,
    ).toBe(false);
  });

  test("fire-and-forget send_agent_message accepts the same delivery field", () => {
    const parsed = SendAgentMessageSchema.parse({
      type: "send_agent_message",
      agentId: "agent-1",
      text: "hello",
      delivery: "follow_up",
    });
    expect(parsed).toMatchObject({ delivery: "follow_up" });
  });

  test("an old daemon still parses a new request by dropping delivery", () => {
    const parsed = PreviousSendAgentMessageRequestSchema.parse({
      type: "send_agent_message_request",
      requestId: "req-1",
      agentId: "agent-1",
      text: "hello",
      delivery: "follow_up",
    });
    expect(parsed).toEqual({
      type: "send_agent_message_request",
      requestId: "req-1",
      agentId: "agent-1",
      text: "hello",
    });
  });

  test("legacy responses without acknowledgement fields still parse", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "send_agent_message_response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        accepted: true,
        error: null,
      },
    });
    if (parsed.type !== "send_agent_message_response") {
      throw new Error("expected send_agent_message_response");
    }
    expect(parsed.payload.delivery).toBeUndefined();
    expect(parsed.payload.queue).toBeUndefined();
  });

  test("responses acknowledge delivery and project the native queue", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "send_agent_message_response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        accepted: true,
        error: null,
        delivery: "follow_up",
        queue: { position: 1, depth: 2 },
      },
    });
    if (parsed.type !== "send_agent_message_response") {
      throw new Error("expected send_agent_message_response");
    }
    expect(parsed.payload.delivery).toBe("follow_up");
    expect(parsed.payload.queue).toEqual({ position: 1, depth: 2 });
  });

  test("queue projections reject negative or fractional values", () => {
    expect(AgentMessageQueueProjectionSchema.safeParse({ position: -1, depth: 0 }).success).toBe(
      false,
    );
    expect(AgentMessageQueueProjectionSchema.safeParse({ position: 0.5, depth: 1 }).success).toBe(
      false,
    );
  });

  test("an old client still parses a new response by dropping the acknowledgement", () => {
    const parsed = PreviousSendAgentMessageResponseSchema.parse({
      type: "send_agent_message_response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        accepted: true,
        error: null,
        delivery: "steer",
        queue: { position: 0, depth: 1 },
      },
    });
    expect(parsed.payload).toEqual({
      requestId: "req-1",
      agentId: "agent-1",
      accepted: true,
      error: null,
    });
  });

  test("server_info declares the agentMessageQueue feature only on new daemons", () => {
    const withFeature = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-1",
      features: { agentMessageQueue: true },
    });
    expect(withFeature.features?.agentMessageQueue).toBe(true);

    const legacyDaemon = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-1",
      features: {},
    });
    expect(legacyDaemon.features?.agentMessageQueue).toBeUndefined();
  });
});
