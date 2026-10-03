/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore, produce } from "solid-js/store"
import type { SessionMessageInfo } from "@opencode/client"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { ThemeProvider } from "../../src/context/theme"
import { ConfigProvider } from "../../src/config"
import { ChangeDetail } from "../../src/feature-plugins/system/changes"
import { deriveHistory, type PersistedChange } from "../../src/feature-plugins/system/changes-model"
import { emptyThemeSource } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const location = { directory: "/tmp/project", workspaceID: "workspace" }

function messages() {
  return [
    { id: "u1", type: "user", text: "Fix the parser" },
    {
      id: "m1",
      type: "assistant",
      content: [
        { id: "r", type: "reasoning", text: "I will rewrite the parse loop." },
        {
          id: "tool",
          type: "tool",
          name: "edit",
          state: {
            status: "completed",
            input: {},
            metadata: {
              files: [{ file: "src/parser.ts", additions: 1, deletions: 1, status: "modified" }],
            },
          },
        },
      ],
      time: { created: 1, completed: 2 },
    },
  ] as unknown as SessionMessageInfo[]
}

type DiffList = Array<{ file: string; patch: string }>

function context(
  stepDiff: (input: { sessionID: string; messageID: string; context?: number }) => Promise<DiffList>,
  change?: PersistedChange,
  workingDiff: (input: {
    location: unknown
    mode: string
    context?: number
  }) => Promise<{ data: DiffList }> = async () => ({
    data: [],
  }),
  provider = "git",
) {
  const color = RGBA.fromInts(200, 200, 200)
  const feedback = { base: color, muted: color }
  const history = { sessions: { session: deriveHistory(messages()) } }
  if (change) history.sessions.session[0]!.steps[0]!.changes = [change]
  const selected = history.sessions.session[0]!.steps[0]!.changes[0]!
  const [state, setState] = createStore({
    expanded: {} as Record<string, boolean>,
    selection: { sessionID: "session", changeID: selected.id },
  })
  const theme = {
    text: {
      base: color,
      muted: color,
      action: { destructive: { base: color } },
      formfield: { base: color, focused: color, selected: color, disabled: color },
      feedback: { error: feedback, warning: feedback, success: feedback },
    },
    background: { raised: { base: color, high: color, max: color }, base: color },
    diff: {
      text: { added: color, removed: color, hunkHeader: color },
      highlight: { added: color, removed: color },
      background: { added: color, removed: color, context: color },
      lineNumber: { text: color, background: { added: color, removed: color } },
    },
    categorical: [{ 300: color }],
    border: { base: color },
  }
  return {
    theme,
    data: {
      location: {
        vcs: { info: () => ({ provider }) },
        default: () => location,
      },
      session: {
        get: () => ({ location }),
        message: { get: () => undefined },
      },
    },
    client: { session: { step: { diff: stepDiff } }, vcs: { diff: workingDiff } },
    storage: {
      store: () => [history, () => {}],
      memory: () => [
        state,
        (mutation: (draft: { expanded: Record<string, boolean> }) => void) => setState(produce(mutation)),
      ],
    },
    ui: { toast: { show: () => {} }, dialog: { confirm: async () => false } },
  } as unknown as Context
}

const input = {
  name: "changes",
  sessionID: "session",
  width: 80,
  presentation: "panel",
  focused: true,
  focus: () => {},
  close: () => {},
  toggleFullscreen: () => {},
} as PanelInput

function render(ctx: Context) {
  return testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider mode="dark" source={emptyThemeSource}>
          <ChangeDetail context={ctx} input={input} />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 80, height: 20 },
  )
}

test("loads a change's diff from the step endpoint on selection", async () => {
  const calls: Array<{ messageID: string; context?: number }> = []
  const ctx = context(async (query) => {
    calls.push({ messageID: query.messageID, context: query.context })
    return [{ file: "src/parser.ts", patch: "@@ -1 +1 @@\n-old line\n+new line" }]
  })
  const app = await render(ctx)
  try {
    await app.waitForFrame((frame) => frame.includes("new line"))
    // A bounded context keeps a change in a large file from rendering the whole file.
    expect(calls).toEqual([{ messageID: "m1", context: 3 }])
    const frame = app.captureCharFrame()
    expect(frame).toContain("src/parser.ts")
    expect(frame).toContain("I will rewrite the parse loop.")
  } finally {
    app.renderer.destroy()
  }
})

test("falls back to the working-tree diff when the step diff has no match", async () => {
  const calls: Array<{ mode: string; context?: number }> = []
  const ctx = context(
    async () => [],
    undefined,
    async (input) => {
      calls.push({ mode: input.mode, context: input.context })
      return { data: [{ file: "packages/tui/src/parser.ts", patch: "@@ -1 +1 @@\n-gone\n+working" }] }
    },
  )
  const app = await render(ctx)
  try {
    await app.waitForFrame((frame) => frame.includes("working"))
    expect(calls).toEqual([{ mode: "working", context: 3 }])
  } finally {
    app.renderer.destroy()
  }
})

test("reports no diff in a non-git project without calling the git fallback", async () => {
  let working = 0
  const ctx = context(
    async () => [],
    undefined,
    async () => {
      working++
      return { data: [] }
    },
    "none",
  )
  const app = await render(ctx)
  try {
    await app.waitForFrame((frame) => frame.includes("No diff available"))
    expect(working).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("a legacy stored patch is shown without calling the step endpoint", async () => {
  let called = 0
  const ctx = context(
    async () => {
      called++
      return []
    },
    {
      id: "tool:0",
      file: "src/parser.ts",
      additions: 1,
      deletions: 1,
      messageID: "m1",
      patch: "@@ -1 +1 @@\n-legacy\n+restored",
    },
  )
  const app = await render(ctx)
  try {
    await app.waitForFrame((frame) => frame.includes("restored"))
    expect(called).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("says a plan document has no expected diff instead of a bare no-diff message", async () => {
  const ctx = context(async () => [], {
    id: "tool:0",
    file: ".opencode/plan/todo.md",
    additions: 1,
    deletions: 1,
    messageID: "m1",
    kind: "plan",
  })
  const app = await render(ctx)
  try {
    await app.waitForFrame((frame) => frame.includes("No diff expected") && frame.includes("plan document"))
  } finally {
    app.renderer.destroy()
  }
})

test("falls back to the branch diff when the working tree is clean", async () => {
  const modes: string[] = []
  const ctx = context(
    async () => [],
    undefined,
    async (input) => {
      modes.push(input.mode)
      return input.mode === "branch"
        ? { data: [{ file: "src/parser.ts", patch: "@@ -1 +1 @@\n-committed\n+branch change" }] }
        : { data: [] }
    },
  )
  const app = await render(ctx)
  try {
    await app.waitForFrame((frame) => frame.includes("branch change"))
    expect(modes).toEqual(["working", "branch"])
  } finally {
    app.renderer.destroy()
  }
})

test("marks a change that is in no tracked tree as having no expected diff", async () => {
  const ctx = context(
    async () => [],
    undefined,
    async () => ({ data: [] }),
  )
  const app = await render(ctx)
  try {
    await app.waitForFrame((frame) => frame.includes("not in a tracked tree"))
  } finally {
    app.renderer.destroy()
  }
})
