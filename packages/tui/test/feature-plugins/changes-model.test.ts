import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { deriveHistory, mergeHistory, type SessionPrompt } from "../../src/feature-plugins/system/changes-model"

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
    expect(prompts[0].steps[0].changes[0].patch).toBeUndefined()
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
})
