/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore, produce } from "solid-js/store"
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

function context(
  expanded: Record<string, boolean> = {},
  source: SessionMessageInfo[] = messages,
  ignored: string[] = [],
) {
  const color = RGBA.fromInts(200, 200, 200)
  const feedback = { base: color, muted: color }
  // Seed the accumulated history the tree renders from.
  const history = { sessions: { session: deriveHistory(source) } }
  const [state, setState] = createStore<{ expanded: Record<string, boolean> }>({ expanded })
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
    data: {
      session: { get: () => undefined, message: { list: () => messages } },
      location: { default: () => ({ directory: "/tmp", workspaceID: "workspace" }) },
    },
    client: { vcs: { ignored: async () => ({ data: ignored }) } },
    ui: { panel: { open: () => true } },
    storage: {
      store: () => [history, () => {}],
      memory: () => [
        state,
        (mutation: (draft: { expanded: Record<string, boolean> }) => void) => setState(produce(mutation)),
      ],
    },
  } as unknown as Context
}

test("task tree nests change-bearing steps under prompts", async () => {
  const ctx = context()
  const app = await testRender(() => <TaskTree context={ctx} sessionID="session" />, { width: 48, height: 12 })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Changes")
    expect(frame).toContain("Fix the parser")
    expect(frame).toContain("Refactor the parser")
    // A step that only read files produced no change and must not appear.
    expect(frame).not.toContain("Inspect the parser")
  } finally {
    app.renderer.destroy()
  }
})

test("clicking a step arrow expands its changes", async () => {
  const ctx = context()
  const app = await testRender(() => <TaskTree context={ctx} sessionID="session" />, { width: 48, height: 12 })

  try {
    await app.renderOnce()
    const row = app
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Refactor the parser"))
    await app.mockMouse.click(2, row)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("src/parser.ts")
  } finally {
    app.renderer.destroy()
  }
})

test("marks a planning step as having no worktree diff", async () => {
  const plan = [
    { id: "u1", type: "user", text: "Plan the work" },
    {
      id: "m1",
      type: "assistant",
      content: [
        { id: "t", type: "text", text: "Draft the todo" },
        {
          id: "tool",
          type: "tool",
          name: "write",
          state: { status: "completed", input: { path: ".opencode/plan/todo.md" }, metadata: {} },
        },
      ],
      time: { created: 1, completed: 2 },
    },
  ] as unknown as SessionMessageInfo[]
  const ctx = context({}, plan)
  const app = await testRender(() => <TaskTree context={ctx} sessionID="session" />, { width: 60, height: 8 })

  try {
    await app.renderOnce()
    const row = app
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("Draft the todo"))
    // The step carries a `plan` marker so a step with no expected diff is visually separated.
    expect(row).toContain("plan")
  } finally {
    app.renderer.destroy()
  }
})

test("marks an ignored change as having no tracked diff", async () => {
  // Steps default collapsed; expand the step that holds the change so its rows render.
  const ctx = context({ m1: true }, messages, ["src/parser.ts"])
  const app = await testRender(() => <TaskTree context={ctx} sessionID="session" />, { width: 60, height: 12 })

  try {
    // The ignored-path resource resolves on a microtask, so let it settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await app.waitForFrame((frame) => frame.includes("untracked"), { maxPasses: 50 })
    const row = app
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("src/parser.ts"))
    expect(row).toContain("untracked")
  } finally {
    app.renderer.destroy()
  }
})
