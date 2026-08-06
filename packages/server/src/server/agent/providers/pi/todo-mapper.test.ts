import { describe, expect, test } from "vitest";

import { mapPiTodoWrite } from "./todo-mapper.js";

describe("Pi todo mapper", () => {
  test("maps todowrite arguments and preserves an empty replacement", () => {
    expect(
      mapPiTodoWrite("todowrite", {
        todos: [
          { content: "done", status: "completed" },
          { content: "next", status: "in_progress", priority: "high" },
          { content: "skipped", status: "cancelled" },
        ],
      }),
    ).toEqual({
      type: "todo",
      items: [
        { text: "done", completed: true },
        { text: "next", completed: false },
      ],
    });
    expect(mapPiTodoWrite("todowrite", { todos: [] })).toEqual({ type: "todo", items: [] });
  });

  test("treats unknown statuses as pending and drops malformed calls", () => {
    expect(
      mapPiTodoWrite("todowrite", { todos: [{ content: "unknown", status: "future" }] }),
    ).toEqual({ type: "todo", items: [{ text: "unknown", completed: false }] });
    expect(mapPiTodoWrite("todowrite", { todos: [{ status: "pending" }] })).toBeNull();
    expect(mapPiTodoWrite("write", { todos: [] })).toBeNull();
  });
});
