import { z } from "zod";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";

const PiTodoWriteSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string().min(1),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]).catch("pending"),
    }),
  ),
});

type TodoTimelineItem = Extract<AgentTimelineItem, { type: "todo" }>;

export function mapPiTodoWrite(toolName: string, args: unknown): TodoTimelineItem | null {
  if (toolName !== "todowrite") {
    return null;
  }
  const parsed = PiTodoWriteSchema.safeParse(args);
  if (!parsed.success) {
    return null;
  }
  return {
    type: "todo",
    items: parsed.data.todos
      .filter((todo) => todo.status !== "cancelled")
      .map((todo) => ({ text: todo.content, completed: todo.status === "completed" })),
  };
}
