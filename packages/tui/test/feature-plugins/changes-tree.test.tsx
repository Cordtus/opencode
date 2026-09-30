/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { TaskTree } from "../../src/feature-plugins/system/changes"
import { deriveHistory } from "../../src/feature-plugins/system/changes-model"

const messages = [
  { id: "u1", type: "user", text: "Fix the parser" },
  {
    id: "m1",
    type: "assistant",
    content: [
      { id: "t", type: "text", text: "Refactor the parser" },
      {
        id: "tool",
        type: "tool",
        name: "edit",
        state: {
          status: "completed",
          input: {},
          metadata: { files: [{ file: "src/parser.ts", patch: "@@ -1 +1 @@\n-a\n+b", additions: 1, deletions: 1 }] },
        },
      },
    ],
    time: { created: 1, completed: 2 },
  },
  {
    id: "m2",
    type: "assistant",
    content: [
      { id: "t2", type: "text", text: "Inspect the parser" },
      { id: "tool2", type: "tool", name: "read", state: { status: "completed", input: {}, metadata: {} } },
    ],
    time: { created: 3, completed: 4 },
  },
] as unknown as SessionMessageInfo[]

function context(expanded: Record<string, boolean> = {}) {
  const color = RGBA.fromInts(200, 200, 200)
  const feedback = { base: color, muted: color }
  // Seed the accumulated history the tree renders from.
  const history = { sessions: { session: deriveHistory(messages) } }
  return {
    theme: {
      text: {
        base: color,
        muted: color,
        formfield: { base: color, focused: color, selected: color, disabled: color },
        feedback: { error: feedback, warning: feedback, success: feedback },
      },
      background: { raised: { base: color, high: color, max: color } },
      diff: { text: { added: color, removed: color } },
      categorical: [{ 300: color }],
      border: { base: color },
    },
    data: { session: { message: { list: () => messages } } },
    ui: { panel: { open: () => true } },
    storage: {
      store: () => [history, () => {}],
      memory: (_key: string, options: { initial: unknown }) => [{ ...(options.initial as object), expanded }, () => {}],
    },
  } as unknown as Context
}

test("task tree nests steps under prompts", async () => {
  const app = await testRender(() => <TaskTree context={context()} sessionID="session" />, { width: 48, height: 12 })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Changes")
    expect(frame).toContain("Fix the parser")
    expect(frame).toContain("Refactor the parser")
    expect(frame).toContain("Inspect the parser")
  } finally {
    app.renderer.destroy()
  }
})

test("a step with no changes cannot expand even if it was previously expanded", async () => {
  // The read-only step's expansion state is stale-true; it must stay collapsed because it has
  // no changes, so the old "No changes recorded." fallback must never render.
  const app = await testRender(() => <TaskTree context={context({ m2: true })} sessionID="session" />, {
    width: 48,
    height: 12,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("No changes recorded.")
  } finally {
    app.renderer.destroy()
  }
})
