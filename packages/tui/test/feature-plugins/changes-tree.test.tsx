/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { TaskTree } from "../../src/feature-plugins/system/changes"

function context() {
  const color = RGBA.fromInts(200, 200, 200)
  const feedback = { base: color, muted: color }
  return {
    theme: {
      text: { base: color, muted: color, feedback: { error: feedback, warning: feedback, success: feedback } },
      background: { raised: { base: color, high: color, max: color } },
      diff: { text: { added: color, removed: color } },
    },
    data: {
      session: {
        message: {
          list: () => [
            {
              id: "m1",
              type: "assistant",
              content: [
                { id: "t", type: "text", text: "Add the panel" },
                { id: "r", type: "reasoning", text: "thinking" },
                {
                  id: "tool",
                  type: "tool",
                  name: "edit",
                  state: {
                    status: "completed",
                    input: {},
                    metadata: {
                      files: [{ file: "src/panel.ts", patch: "@@ -1 +1 @@\n-a\n+b", additions: 1, deletions: 1 }],
                    },
                  },
                },
              ],
              time: { created: 1, completed: 2 },
            },
          ],
        },
      },
    },
    ui: { panel: { open: () => true } },
  } as unknown as Context
}

test("task tree lists steps derived from assistant messages", async () => {
  const app = await testRender(() => <TaskTree context={context()} sessionID="session" />, { width: 42, height: 10 })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Changes")
    expect(frame).toContain("Add the panel")
  } finally {
    app.renderer.destroy()
  }
})
