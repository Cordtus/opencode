import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { tmpdir } from "../fixture/fixture"

// End-to-end guard for the reported `✕` behavior: open the changes panel from the sidebar,
// take it fullscreen (the case that hides the session pane), close it, and confirm the prompt
// accepts input again. Closing unmounts the node that held renderer focus.
test.skipIf(process.platform === "win32")("closing the changes panel returns focus to the prompt", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 180, height: 40, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const session = {
    id: "ses_panel_focus",
    title: "Panel focus fixture",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const messages = [
    { id: "u1", type: "user", text: "Fix the parser", time: { created: 0 } },
    {
      id: "m1",
      type: "assistant",
      content: [
        { id: "r1", type: "reasoning", text: "I will rewrite the parse loop." },
        {
          id: "t1",
          type: "tool",
          name: "edit",
          state: {
            status: "completed",
            input: {},
            metadata: { files: [{ file: "src/parser.ts", additions: 1, deletions: 1, status: "modified" }] },
          },
        },
      ],
      time: { created: 1, completed: 2 },
    },
  ]
  const calls = createFetch((url, request) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
    if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
    if (url.pathname === "/api/vcs/ignored") return json({ data: [] })
    if (url.pathname === `/api/session/${session.id}/step/m1/diff`)
      return json({
        data: [
          {
            file: "src/parser.ts",
            patch: "@@ -1 +1 @@\n-old line\n+new line",
            additions: 1,
            deletions: 1,
            status: "modified",
          },
        ],
      })
    return undefined
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { mode: "off" } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )

  const cell = (needle: string) => {
    const lines = setup.captureCharFrame().split("\n")
    for (let y = 0; y < lines.length; y++) {
      const x = lines[y]!.indexOf(needle)
      if (x !== -1) return { x, y }
    }
    return undefined
  }

  try {
    // The durable changes projection is debounced ~600ms, then the tree renders collapsed steps.
    await setup.waitForFrame((frame) => frame.includes("Step 1"))
    const step = cell("Step 1")
    if (!step) throw new Error("Step row not found")
    await setup.mockMouse.click(step.x + 1, step.y)
    await setup.waitForFrame((frame) => frame.includes("src/parser.ts"))

    const change = cell("src/parser.ts")
    if (!change) throw new Error("Change row not found")
    await setup.mockMouse.click(change.x + 1, change.y)
    await setup.waitForFrame((frame) => frame.includes("Reasoning") && frame.includes("✕"))

    // Fullscreen hides the session pane; the close must still restore focus.
    const fullscreen = cell("⤢")
    if (!fullscreen) throw new Error("Panel fullscreen button not found")
    await setup.mockMouse.click(fullscreen.x, fullscreen.y)
    await setup.waitForVisualIdle()

    const close = cell("✕")
    if (!close) throw new Error("Panel close button not found")
    await setup.mockMouse.click(close.x, close.y)
    await setup.waitForVisualIdle()
    expect(setup.captureCharFrame()).not.toContain("Reasoning")

    // Typing only reaches the prompt if focus was handed back rather than left on the closed panel.
    setup.mockInput.typeText("hello after close")
    await setup.waitForFrame((frame) => frame.includes("hello after close"))
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
})
