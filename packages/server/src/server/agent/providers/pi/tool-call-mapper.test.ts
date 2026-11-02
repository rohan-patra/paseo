import { describe, expect, test } from "vitest";

import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  splitPiToolResultImages,
} from "./tool-call-mapper.js";

describe("Pi tool call mapper", () => {
  test("maps bash args and result to shell detail", () => {
    const toolCall = parseToolArgs("bash", { command: "echo hello" });
    const result = parseToolResult({ output: "hello\n", exitCode: 0 });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "shell",
      command: "echo hello",
      output: "hello\n",
      exitCode: 0,
    });
  });

  test("prefers the native edit patch over Pi's display diff", () => {
    const toolCall = parseToolArgs("edit", {
      path: "app.ts",
      old_string: "before",
      new_string: "after",
    });
    const result = parseToolResult({
      details: { diff: " 1|before\n-2|before\n+2|after", patch: "@@ -1 +1 @@\n-before\n+after" },
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "edit",
      filePath: "app.ts",
      oldString: "before",
      newString: "after",
      unifiedDiff: "@@ -1 +1 @@\n-before\n+after",
    });
  });

  test("turns writes with a captured original file into diff details", () => {
    const toolCall = parseToolArgs("write", { path: "notes.txt", content: "after\n" });

    expect(
      mapToolDetail(toolCall, parseToolResult({ details: { oldContent: "before\n" } })),
    ).toEqual({
      type: "edit",
      filePath: "notes.txt",
      oldString: "before\n",
      newString: "after\n",
      unifiedDiff: undefined,
    });
  });

  test("renders a new write as a diff when its captured original is empty", () => {
    const toolCall = parseToolArgs("write", { path: "notes.txt", content: "created\n" });

    expect(mapToolDetail(toolCall, parseToolResult({ details: { oldContent: "" } }))).toMatchObject(
      {
        type: "edit",
        filePath: "notes.txt",
        oldString: "",
        newString: "created\n",
      },
    );
  });

  test("preserves ordinary writes as write details", () => {
    const toolCall = parseToolArgs("write", { path: "notes.txt", content: "unchanged\n" });

    expect(mapToolDetail(toolCall, parseToolResult({ text: "Wrote notes.txt" }))).toEqual({
      type: "write",
      filePath: "notes.txt",
      content: "unchanged\n",
    });
  });

  test("maps executed xdev writes to their wrapped tool detail", () => {
    const toolCall = parseToolArgs("write", {
      path: "xd://browser",
      content: "{}",
    });
    const result = parseToolResult({
      content: [{ type: "text", text: "Opened Example Domain" }],
      details: {
        xdev: {
          tool: "browser",
          mode: "execute",
          args: { action: "open", url: "https://example.com" },
          inner: { title: "Example Domain" },
        },
        oldContent: "must not become a file diff",
      },
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { action: "open", url: "https://example.com" },
      output: {
        content: [{ type: "text", text: "Opened Example Domain" }],
        details: { title: "Example Domain" },
      },
    });
    expect(resolveToolCallName(toolCall, result)).toBe("browser");
  });

  test("does not treat xdev help metadata as an executed inner tool", () => {
    const toolCall = parseToolArgs("write", {
      path: "xd://browser",
      content: "",
    });
    const result = parseToolResult({
      details: {
        xdev: {
          tool: "browser",
          mode: "help",
          inner: "Browser help",
        },
      },
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { path: "xd://browser", content: "" },
      output: result,
    });
    expect(resolveToolCallName(toolCall, result)).toBe("write");
  });

  test("does not treat malformed xdev metadata as an executed inner tool", () => {
    const toolCall = parseToolArgs("write", {
      path: "xd://browser",
      content: "{}",
    });
    const result = parseToolResult({
      details: {
        xdev: {
          tool: "",
          mode: "execute",
          args: { action: "open" },
          inner: { title: "must not surface" },
        },
      },
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { path: "xd://browser", content: "{}" },
      output: result,
    });
    expect(resolveToolCallName(toolCall, result)).toBe("write");
  });

  test("surfaces any path-based tool with a supplied patch as an edit", () => {
    const toolCall = parseToolArgs("ast_grep_replace", { path: "src/app.ts", pattern: "old" });
    const result = parseToolResult({ details: { patch: "@@ -1 +1 @@\n-old\n+new" } });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "edit",
      filePath: "src/app.ts",
      unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
    });
  });

  test("preserves unknown tool input and parsed output", () => {
    const toolCall = parseToolArgs("custom_tool", { value: 42 });
    const result = parseToolResult({ text: "custom result" });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { value: 42 },
      output: { text: "custom result" },
    });
  });

  test("preserves generic task input while running", () => {
    const toolCall = parseToolArgs("task", {
      agent: "explore",
      task: "Trace the Pi provider tool mapper",
    });

    expect(mapToolDetail(toolCall, null)).toEqual({
      type: "unknown",
      input: { agent: "explore", task: "Trace the Pi provider tool mapper" },
      output: null,
    });
  });

  test("preserves completed generic subagent input and result", () => {
    const toolCall = parseToolArgs("subagent", {
      agent: "reviewer",
      task: "Review the Pi mapper change",
    });
    const result = parseToolResult({
      content: [{ type: "text", text: "The mapper change preserves provider status." }],
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { agent: "reviewer", task: "Review the Pi mapper change" },
      output: result,
    });
  });
});

describe("splitPiToolResultImages", () => {
  test("extracts image blocks and replaces them with [image] placeholders", () => {
    const parsed = parseToolResult({
      content: [
        { type: "text", text: "shot taken" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
    const { images, result } = splitPiToolResultImages(parsed);

    expect(images).toEqual([{ data: "aGVsbG8=", mimeType: "image/png" }]);
    expect(result).toEqual({
      content: [
        { type: "text", text: "shot taken" },
        { type: "text", text: "[image]" },
      ],
    });
  });

  test("replaces image-only results with a non-empty placeholder", () => {
    const parsed = parseToolResult({
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }],
    });
    const { images, result } = splitPiToolResultImages(parsed);

    expect(images).toHaveLength(1);
    expect(extractTextFromToolResult(result)).toBe("[image]");
  });

  test("passes through string results and results without images", () => {
    expect(splitPiToolResultImages("plain output")).toEqual({
      images: [],
      result: "plain output",
    });
    const textOnly = parseToolResult({ content: [{ type: "text", text: "no images" }] });
    expect(splitPiToolResultImages(textOnly)).toEqual({ images: [], result: textOnly });
    expect(splitPiToolResultImages(null)).toEqual({ images: [], result: null });
  });

  test("keeps other fields on the result object", () => {
    const parsed = parseToolResult({
      exitCode: 0,
      content: [{ type: "image", data: "aGVsbG8=" }],
    });
    const { result } = splitPiToolResultImages(parsed);
    expect(result).toMatchObject({ exitCode: 0 });
  });
});

test("tool-result images remove nested structured image data while preserving metadata", () => {
  const data = Buffer.from("nested screenshot bytes").toString("base64");
  const result = parseToolResult({
    content: [{ type: "image", data, mimeType: "image/png" }],
    structuredContent: {
      content: [{ type: "image", data, mimeType: "image/png", width: 64 }],
      captureId: "capture-1",
      read: { type: "image", data, mimeType: "image/png", note: "Read image file" },
      extra: { data: "keep ordinary data" },
    },
  });
  const split = splitPiToolResultImages(result);
  const detail = mapToolDetail(parseToolArgs("screenshot", {}), split.result);
  expect(JSON.stringify(detail)).not.toContain(data);
  expect(split.images).toEqual([{ data, mimeType: "image/png" }]);
  expect(split.result).toMatchObject({
    structuredContent: {
      content: [{ type: "image", data: "[image]", mimeType: "image/png", width: 64 }],
      captureId: "capture-1",
      read: { type: "image", data: "[image]", mimeType: "image/png", note: "Read image file" },
      extra: { data: "keep ordinary data" },
    },
  });
});
