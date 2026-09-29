import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { deriveSteps } from "../../src/feature-plugins/system/changes-model"

const assistant = (id: string, content: unknown[], time: { completed?: number } = { completed: 2 }) =>
  ({ id, type: "assistant", content, time: { created: 1, ...time } }) as unknown as SessionMessageInfo

const text = (value: string) => ({ id: `text-${value}`, type: "text", text: value })
const reasoning = (value: string) => ({ id: `reasoning-${value}`, type: "reasoning", text: value })
const tool = (name: string, metadata: Record<string, unknown>, input: Record<string, unknown> = {}) => ({
  id: `tool-${name}`,
  type: "tool",
  name,
  state: { status: "completed", input, metadata },
})

describe("changes-model.deriveSteps", () => {
  test("builds a step from an assistant message with reasoning and metadata.files", () => {
    const steps = deriveSteps([
      assistant("m1", [
        text("Refactor the parser"),
        reasoning("I will rewrite this"),
        tool("edit", {
          files: [
            { file: "src/parser.ts", patch: "@@ -1 +1 @@\n-a\n+b", additions: 1, deletions: 1, status: "modified" },
          ],
        }),
      ]),
    ])

    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({
      id: "m1",
      label: "Refactor the parser",
      status: "done",
      reasoning: "I will rewrite this",
    })
    expect(steps[0].changes).toHaveLength(1)
    expect(steps[0].changes[0]).toMatchObject({ file: "src/parser.ts", additions: 1, deletions: 1, status: "modified" })
  })

  test("drops finished steps with no changes but keeps a running one", () => {
    const steps = deriveSteps([
      assistant("m1", [text("no changes")], { completed: 2 }),
      assistant("m2", [text("working")], {}),
    ])

    expect(steps.map((step) => step.id)).toEqual(["m2"])
    expect(steps[0].status).toBe("running")
  })

  test("falls back to the tool input path for a write with no patch", () => {
    const steps = deriveSteps([assistant("m1", [tool("write", {}, { path: "src/new.ts" })])])

    expect(steps[0].changes[0]).toMatchObject({ file: "src/new.ts", additions: 0, deletions: 0 })
    expect(steps[0].changes[0].patch).toBeUndefined()
  })

  test("derives add and delete statuses from patch text", () => {
    const steps = deriveSteps([
      assistant("m1", [
        tool("edit", { files: [{ file: "a.ts", patch: "new file mode\n@@ +1 @@\n+a", additions: 1, deletions: 0 }] }),
        tool("edit", {
          files: [{ file: "b.ts", patch: "deleted file mode\n@@ -1 @@\n-b", additions: 0, deletions: 1 }],
        }),
      ]),
    ])

    expect(steps[0].changes.map((change) => change.status)).toEqual(["added", "deleted"])
  })
})
