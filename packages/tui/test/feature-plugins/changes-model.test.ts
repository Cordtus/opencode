import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import {
  deriveHistory,
  legacyPatch,
  livePatch,
  matchesFile,
  mergeHistory,
  type SessionPrompt,
} from "../../src/feature-plugins/system/changes-model"

const user = (id: string, text: string) => ({ id, type: "user", text }) as unknown as SessionMessageInfo
const assistant = (id: string, content: unknown[], time: { completed?: number } = { completed: 2 }) =>
  ({ id, type: "assistant", content, time: { created: 1, ...time } }) as unknown as SessionMessageInfo

const text = (value: string) => ({ id: `text-${value}`, type: "text", text: value })
const reasoning = (value: string) => ({ id: `reasoning-${value}`, type: "reasoning", text: value })
const tool = (
  name: string,
  metadata: Record<string, unknown>,
  input: Record<string, unknown> = {},
  status: "completed" | "running" | "error" = "completed",
) => ({ id: `tool-${name}`, type: "tool", name, state: { status, input, metadata } })

describe("changes-model.deriveHistory", () => {
  test("nests steps under the prompt that started them", () => {
    const prompts = deriveHistory([
      user("u1", "Fix the parser"),
      assistant("m1", [
        text("Refactor the parser"),
        reasoning("I will rewrite this"),
        tool("edit", {
          files: [
            { file: "src/parser.ts", patch: "@@ -1 +1 @@\n-a\n+b", additions: 1, deletions: 1, status: "modified" },
          ],
        }),
      ]),
      user("u2", "Now add tests"),
      assistant("m2", [text("Adding tests")]),
    ])

    expect(prompts.map((prompt) => prompt.id)).toEqual(["u1", "u2"])
    expect(prompts[0].steps).toHaveLength(1)
    expect(prompts[0].steps[0]).toMatchObject({
      id: "m1",
      label: "Refactor the parser",
      status: "done",
      reasoning: "I will rewrite this",
    })
    expect(prompts[0].steps[0].changes[0]).toMatchObject({
      file: "src/parser.ts",
      additions: 1,
      deletions: 1,
      status: "modified",
    })
  })

  test("keeps a completed step that produced no changes", () => {
    const prompts = deriveHistory([user("u1", "Do work"), assistant("m1", [tool("bash", {})], { completed: 2 })])

    expect(prompts[0].steps).toHaveLength(1)
    expect(prompts[0].steps[0].changes).toHaveLength(0)
  })

  test("falls back to the tool input path for a write with no metadata", () => {
    const prompts = deriveHistory([
      user("u1", "Create a file"),
      assistant("m1", [tool("write", {}, { path: "src/new.ts" })]),
    ])

    expect(prompts[0].steps[0].changes[0]).toMatchObject({ file: "src/new.ts", additions: 0, deletions: 0 })
    expect(prompts[0].steps[0].changes[0].status).toBeUndefined()
  })

  test("uses the status reported by metadata.files and ignores incomplete calls", () => {
    const prompts = deriveHistory([
      user("u1", "Edit"),
      assistant("m1", [
        tool("edit", { files: [{ file: "a.ts", patch: "@@ +1 @@\n+a", additions: 1, deletions: 0, status: "added" }] }),
        tool("edit", { files: [{ file: "b.ts", patch: "@@ -1 @@\n-b", additions: 0, deletions: 1 }] }, {}, "running"),
      ]),
    ])

    expect(prompts[0].steps[0].changes.map((change) => change.status)).toEqual(["added"])
  })

  test("marks edits to the plan directory as plan changes", () => {
    const prompts = deriveHistory([
      user("u1", "Plan"),
      assistant("m1", [
        tool("write", {}, { path: "/home/user/.opencode/plan/thing.md" }),
        tool("edit", {
          files: [{ file: "/home/user/.opencode/plan/other.md", patch: "@@ +1 @@\n+a", additions: 1, deletions: 0 }],
        }),
        tool("edit", {
          files: [{ file: "src/parser.ts", patch: "@@ +1 @@\n+a", additions: 1, deletions: 0 }],
        }),
      ]),
    ])

    expect(prompts[0].steps[0].changes.map((change) => change.kind)).toEqual(["plan", "plan", undefined])
  })
})

describe("changes-model.matchesFile", () => {
  test("matches exact paths and worktree-prefixed paths for a subdirectory location", () => {
    expect(matchesFile("src/parser.ts", "src/parser.ts")).toBe(true)
    expect(matchesFile("packages/tui/src/parser.ts", "src/parser.ts")).toBe(true)
    expect(matchesFile("src/parser.ts", "./src/parser.ts")).toBe(true)
    expect(matchesFile("packages/tui/src/other.ts", "src/parser.ts")).toBe(false)
    // A suffix match must respect the path segment boundary.
    expect(matchesFile("src/notparser.ts", "parser.ts")).toBe(false)
  })
})

describe("changes-model.mergeHistory", () => {
  test("retains steps the client window no longer reports", () => {
    const previous: SessionPrompt[] = [
      { id: "u1", label: "First", steps: [{ id: "m1", label: "Step 1", status: "done", reasoning: "r", changes: [] }] },
    ]
    const next: SessionPrompt[] = [
      {
        id: "u1",
        label: "First",
        steps: [{ id: "m2", label: "Step 2", status: "running", reasoning: "", changes: [] }],
      },
    ]

    const merged = mergeHistory(previous, next)
    expect(merged[0].steps.map((step) => step.id)).toEqual(["m1", "m2"])
  })

  test("updates an existing step in place", () => {
    const previous: SessionPrompt[] = [
      {
        id: "u1",
        label: "First",
        steps: [{ id: "m1", label: "Step 1", status: "running", reasoning: "a", changes: [] }],
      },
    ]
    const next: SessionPrompt[] = [
      {
        id: "u1",
        label: "First",
        steps: [{ id: "m1", label: "Step 1", status: "done", reasoning: "a b", changes: [] }],
      },
    ]

    const merged = mergeHistory(previous, next)
    expect(merged[0].steps).toHaveLength(1)
    expect(merged[0].steps[0].status).toBe("done")
    expect(merged[0].steps[0].reasoning).toBe("a b")
  })

  test("preserves a legacy stored patch while replacing the change shape", () => {
    const change = (patch?: string) => ({
      id: "tool:0",
      file: "src/a.ts",
      ...(patch === undefined ? {} : { patch }),
      additions: 2,
      deletions: 3,
      messageID: "m1",
    })
    const previous = [
      {
        id: "u1",
        label: "First",
        steps: [
          { id: "m1", label: "Step 1", status: "running", reasoning: "r", changes: [change("@@ old @@") as never] },
        ],
      },
    ] as SessionPrompt[]
    const next = [
      {
        id: "u1",
        label: "First",
        steps: [{ id: "m1", label: "Step 1", status: "done", reasoning: "r", changes: [change() as never] }],
      },
    ] as SessionPrompt[]

    const merged = mergeHistory(previous, next)
    expect((merged[0].steps[0].changes[0] as { patch?: string }).patch).toBe("@@ old @@")
    expect(merged[0].steps[0].status).toBe("done")
  })

  test("keys a preserved legacy patch by change id, never by position", () => {
    const change = (id: string, file: string, patch?: string) => ({
      id,
      file,
      ...(patch === undefined ? {} : { patch }),
      additions: 1,
      deletions: 1,
      messageID: "m1",
    })
    // A `write` (no patch) precedes an `edit` (patch): positional copying would put the edit's
    // patch on the write's change.
    const previous = [
      {
        id: "u1",
        label: "First",
        steps: [
          {
            id: "m1",
            label: "Step 1",
            status: "done",
            reasoning: "r",
            changes: [
              change("tool-write:0", "src/new.ts") as never,
              change("tool-edit:0", "src/a.ts", "@@ a @@") as never,
            ],
          },
        ],
      },
    ] as SessionPrompt[]
    const next = [
      {
        id: "u1",
        label: "First",
        steps: [
          {
            id: "m1",
            label: "Step 1",
            status: "done",
            reasoning: "r",
            changes: [change("tool-edit:0", "src/a.ts") as never, change("tool-write:0", "src/new.ts") as never],
          },
        ],
      },
    ] as SessionPrompt[]

    const merged = mergeHistory(previous, next)
    const patches = Object.fromEntries(
      merged[0].steps[0].changes.map((item) => [item.id, (item as { patch?: string }).patch]),
    )
    expect(patches).toEqual({ "tool-edit:0": "@@ a @@", "tool-write:0": undefined })
  })
})

describe("changes-model.livePatch", () => {
  const change = { id: "tool:0", file: "src/a.ts", additions: 1, deletions: 1, messageID: "m1" }

  test("reads the completed tool result's patch for the same file", () => {
    const message = assistant("m1", [
      text("Edit"),
      tool("edit", { files: [{ file: "packages/tui/src/a.ts", patch: "@@ live @@", additions: 1, deletions: 1 }] }),
    ])
    expect(livePatch(message, change)).toBe("@@ live @@")
  })

  test("is undefined for an evicted message, a non-assistant message, or a differing file", () => {
    expect(livePatch(undefined, change)).toBeUndefined()
    expect(livePatch(user("u1", "hi"), change)).toBeUndefined()
    expect(
      livePatch(assistant("m1", [tool("edit", { files: [{ file: "src/other.ts", patch: "@@ x @@" }] })]), change),
    ).toBeUndefined()
  })
})
