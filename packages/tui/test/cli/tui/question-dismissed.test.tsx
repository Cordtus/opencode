import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { tmpdir } from "../../fixture/fixture"

// A dismissed or interrupted question must still leave the questions readable in the transcript,
// not just a "Asked N questions" count.
test.skipIf(process.platform === "win32")("a dismissed question still shows its questions", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 120, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const session = {
    id: "ses_question",
    title: "Question fixture",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const messages = [
    { id: "u1", type: "user", text: "Go", time: { created: 0 } },
    {
      id: "m1",
      type: "assistant",
      content: [
        {
          id: "q1",
          type: "tool",
          name: "question",
          time: { created: 1, completed: 2 },
          state: {
            status: "error",
            input: { questions: [{ header: "Panel UI", question: "Keep the tree or flatten the timeline?" }] },
            error: { message: "The user dismissed this question" },
          },
        },
      ],
      time: { created: 1, completed: 2 },
    },
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
    if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
    return undefined
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../../../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({ animations: false, tabs: { mode: "off" } }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("Keep the tree or flatten the timeline?"))
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Questions")
    expect(frame).toContain("No answer recorded")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
})
