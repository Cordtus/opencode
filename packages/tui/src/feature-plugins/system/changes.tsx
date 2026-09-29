import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, Index, on, onCleanup, Show } from "solid-js"
import { useThemes } from "../../context/theme"
import { PatchDiff } from "../../component/patch-diff"
import { filetype } from "../../util/filetype"
import { errorMessage } from "../../util/error"
import type { SessionMessageInfo } from "@opencode/client"
import { deriveHistory, mergeHistory, type SessionChange, type SessionPrompt } from "./changes-model"

type Selection = { sessionID: string; changeID: string }

// Persisted projection: the client only keeps a window of recent messages, so the
// tree is served from this accumulated (disk-backed) history instead.
type HistoryStore = { sessions: Record<string, SessionPrompt[]> }

// Client-local UI state shared by the sidebar tree and the panel. Survives hot reloads.
type ChangesMemory = { expanded: Record<string, boolean>; selection?: Selection }

const HistoryStoreOptions = { initial: { sessions: {} } } satisfies { initial: HistoryStore }
const MemoryOptions = { initial: { expanded: {} } } satisfies { initial: ChangesMemory }

function changeMark(status: SessionChange["status"]) {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  if (status === "modified") return "M"
  return "•"
}

function statusMark(status: "running" | "error" | "done") {
  if (status === "error") return "✕"
  if (status === "running") return "•"
  return "✓"
}

function levelColor(theme: Plugin.Context["theme"], index: number) {
  const colors = theme.categorical
  return colors[index % colors.length]?.[300] ?? theme.text.base
}

function statusColor(theme: Plugin.Context["theme"], status: "running" | "error" | "done") {
  if (status === "error") return theme.text.feedback.error.base
  if (status === "running") return theme.text.feedback.warning.base
  return theme.text.feedback.success.base
}

/**
 * Accumulates `deriveHistory` output into durable storage. Debounced because reasoning
 * streams token-by-token; the union-merge means evicted messages stay in the tree.
 */
function History(props: { context: Plugin.Context }) {
  const history = props.context.storage.store<HistoryStore>("history", HistoryStoreOptions)
  const update = history[1]
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: { sessionID: string; prompts: SessionPrompt[] } | undefined

  const flush = () => {
    if (!pending) return
    const { sessionID, prompts } = pending
    pending = undefined
    void update((draft) => {
      draft.sessions[sessionID] = mergeHistory(draft.sessions[sessionID], prompts)
    })
  }
  createEffect(() => {
    const route = props.context.ui.router.current()
    if (route.type !== "session") return
    const prompts = deriveHistory(props.context.data.session.message.list(route.sessionID))
    if (!prompts.length) return
    pending = { sessionID: route.sessionID, prompts }
    if (!timer) {
      timer = setTimeout(() => {
        timer = undefined
        flush()
      }, 600)
    }
  })
  onCleanup(() => {
    if (timer) clearTimeout(timer)
    flush()
  })

  // The client store only holds a page of messages, so a resumed session would otherwise
  // miss older steps and their changes. Backfill the full session once per session ID
  // and union-merge it; the live effect above then keeps it current.
  const backfilled = new Set<string>()
  createEffect(
    on(
      () => {
        const route = props.context.ui.router.current()
        return route.type === "session" ? route.sessionID : undefined
      },
      (sessionID) => {
        if (!sessionID || backfilled.has(sessionID)) return
        backfilled.add(sessionID)
        void backfill(sessionID)
      },
    ),
  )
  async function backfill(sessionID: string) {
    const collected: SessionMessageInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const response = await props.context.client.message.list({ sessionID, limit: 100, order: "desc", cursor })
      collected.push(...response.data)
      cursor = response.cursor.next ?? undefined
      if (!cursor || response.data.length === 0) break
    }
    if (!collected.length) return
    const prompts = deriveHistory(collected.reverse())
    if (!prompts.length) return
    await update((draft) => {
      draft.sessions[sessionID] = mergeHistory(draft.sessions[sessionID], prompts)
    })
  }
  return null
}

export function TaskTree(props: { context: Plugin.Context; sessionID: string }) {
  const theme = () => props.context.theme
  const history = props.context.storage.store<HistoryStore>("history", HistoryStoreOptions)
  const prompts = () => history[0].sessions[props.sessionID] ?? []
  const memory = props.context.storage.memory<ChangesMemory>("state", MemoryOptions)[0]
  const update = props.context.storage.memory<ChangesMemory>("state", MemoryOptions)[1]

  const toggle = (id: string, fallback: boolean) =>
    update((draft) => {
      draft.expanded[id] = !(draft.expanded[id] ?? fallback)
    })
  const markFg = (change: SessionChange) => {
    if (change.status === "added") return theme().diff.text.added
    if (change.status === "deleted") return theme().diff.text.removed
    return theme().text.muted
  }
  const selected = (id: string) => memory.selection?.sessionID === props.sessionID && memory.selection?.changeID === id
  const open = (change: SessionChange) => {
    update((draft) => {
      draft.selection = { sessionID: props.sessionID, changeID: change.id }
    })
    props.context.ui.panel.open("changes", { presentation: "panel" })
  }

  return (
    <Show when={prompts().length > 0}>
      <box gap={1}>
        <text fg={theme().text.base}>
          <b>Changes</b>
        </text>
        <Index each={prompts()}>
          {(prompt) => {
            const promptExpanded = () => memory.expanded[prompt().id] ?? true
            return (
              <box>
                <box flexDirection="row" gap={1} onMouseDown={() => toggle(prompt().id, true)}>
                  <text flexShrink={0} fg={levelColor(theme(), 0)}>
                    {promptExpanded() ? "▼" : "▶"}
                  </text>
                  <text flexGrow={1} wrapMode="word" fg={levelColor(theme(), 0)}>
                    <b>{prompt().label}</b>
                  </text>
                </box>
                <Show when={promptExpanded()}>
                  <box paddingLeft={2}>
                    <Index each={prompt().steps}>
                      {(step) => {
                        const stepExpanded = () => memory.expanded[step().id] ?? false
                        return (
                          <box>
                            <box flexDirection="row" gap={1} onMouseDown={() => toggle(step().id, false)}>
                              <text flexShrink={0} fg={levelColor(theme(), 1)}>
                                {stepExpanded() ? "▼" : "▶"}
                              </text>
                              <text flexShrink={0} fg={statusColor(theme(), step().status)}>
                                [{statusMark(step().status)}]
                              </text>
                              <text flexGrow={1} wrapMode="word" fg={levelColor(theme(), 1)}>
                                {step().label}
                              </text>
                            </box>
                            <Show when={stepExpanded()}>
                              <box paddingLeft={2}>
                                <Show
                                  when={step().changes.length > 0}
                                  fallback={<text fg={theme().text.muted}>No changes recorded.</text>}
                                >
                                  <Index each={step().changes}>
                                    {(change) => (
                                      <box
                                        flexDirection="row"
                                        gap={1}
                                        onMouseUp={() => open(change())}
                                        backgroundColor={
                                          selected(change().id) ? theme().background.raised.high : undefined
                                        }
                                      >
                                        <text flexShrink={0} fg={markFg(change())}>
                                          {changeMark(change().status)}
                                        </text>
                                        <text
                                          flexGrow={1}
                                          wrapMode="word"
                                          fg={selected(change().id) ? theme().text.base : levelColor(theme(), 2)}
                                        >
                                          {change().file}
                                        </text>
                                        <text flexShrink={0} fg={theme().diff.text.added}>
                                          +{change().additions}
                                        </text>
                                        <text flexShrink={0} fg={theme().diff.text.removed}>
                                          -{change().deletions}
                                        </text>
                                      </box>
                                    )}
                                  </Index>
                                </Show>
                              </box>
                            </Show>
                          </box>
                        )
                      }}
                    </Index>
                  </box>
                </Show>
              </box>
            )
          }}
        </Index>
      </box>
    </Show>
  )
}

function ChangeDetail(props: { context: Plugin.Context; input: PanelInput }) {
  const theme = () => props.context.theme
  const { currentSyntax } = useThemes()
  const history = props.context.storage.store<HistoryStore>("history", HistoryStoreOptions)
  const memory = props.context.storage.memory<ChangesMemory>("state", MemoryOptions)[0]
  const current = createMemo(() => {
    const selection = memory.selection
    if (!selection || selection.sessionID !== props.input.sessionID) return
    for (const prompt of history[0].sessions[props.input.sessionID] ?? []) {
      for (const step of prompt.steps) {
        const change = step.changes.find((item) => item.id === selection.changeID)
        if (change) return { step, change }
      }
    }
    return
  })

  const close = () => {
    props.context.storage.memory<ChangesMemory>("state", MemoryOptions)[1]((draft) => {
      draft.selection = undefined
    })
    props.input.close()
  }

  const undo = async (change: SessionChange) => {
    const list = props.context.data.session.message.list(props.input.sessionID)
    const index = list.findIndex((message) => message.id === change.messageID)
    const boundary = index === -1 ? undefined : list.slice(0, index).findLast((message) => message.type === "user")
    if (!boundary) {
      props.context.ui.toast.show({
        message: "Could not locate the step that introduced this change.",
        variant: "error",
      })
      return
    }
    const confirmed = await props.context.ui.dialog.confirm({
      title: "Undo change",
      message: `Undo changes to ${change.file}?\n\nThis is not a per-file undo. It reverts the entire step that introduced this change: every file change after its triggering message is rolled back and the conversation from that point is hidden. Use /redo to restore it.`,
      label: { confirm: "Undo" },
    })
    if (!confirmed) return
    try {
      const sessionID = props.input.sessionID
      // Revert staging is rejected while the session is executing, so stop and drain it first.
      if (props.context.data.session.status(sessionID) === "running") {
        await props.context.client.session.interrupt({ sessionID })
        await props.context.client.session.wait({ sessionID })
      }
      await props.context.client.session.revert.stage({ sessionID, messageID: boundary.id })
      props.context.storage.memory<ChangesMemory>("state", MemoryOptions)[1]((draft) => {
        draft.selection = undefined
      })
      props.context.ui.toast.show({ message: `Reverted step containing ${change.file}`, variant: "success" })
    } catch (error) {
      props.context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    }
  }

  return (
    <box
      flexGrow={1}
      minWidth={0}
      flexDirection="column"
      border={["left"]}
      borderColor={theme().border.base}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <Show
        when={current()}
        fallback={
          <text fg={theme().text.muted}>Select a change in the sidebar to inspect its diff and reasoning.</text>
        }
      >
        {(value) => (
          <>
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text flexShrink={0} fg={levelColor(theme(), 2)}>
                ▍
              </text>
              <text fg={theme().text.base}>
                <b>{value().change.file}</b>
              </text>
              <Show when={value().change.status}>{(status) => <text fg={theme().text.muted}>[{status()}]</text>}</Show>
              <text fg={theme().diff.text.added}>+{value().change.additions}</text>
              <text fg={theme().diff.text.removed}>-{value().change.deletions}</text>
              <box flexGrow={1} />
              <box onMouseUp={() => void undo(value().change)}>
                <text fg={theme().text.action.destructive.base}>
                  <b>⟲ Undo</b>
                </text>
              </box>
              <box onMouseUp={props.input.toggleFullscreen}>
                <text fg={theme().text.muted}>{props.input.presentation === "fullscreen" ? "⤡" : "⤢"}</text>
              </box>
              <box onMouseUp={close}>
                <text fg={theme().text.muted}>✕</text>
              </box>
            </box>

            <box height={1} flexShrink={0} backgroundColor={theme().border.base} />

            <box flexShrink={0} paddingTop={1}>
              <text fg={levelColor(theme(), 2)}>
                <b>Diff</b>
              </text>
            </box>
            <box flexGrow={1} flexBasis={0} minHeight={0}>
              <scrollbox flexGrow={1} minHeight={0} horizontalScrollbarOptions={{ visible: false }}>
                <Show
                  when={value().change.patch}
                  fallback={<text fg={theme().text.muted}>No diff available for this change.</text>}
                >
                  {(patch) => (
                    <PatchDiff
                      diff={patch()}
                      hunkFg={theme().diff.text.hunkHeader}
                      view="unified"
                      filetype={filetype(value().change.file)}
                      syntaxStyle={currentSyntax()}
                      showLineNumbers={true}
                      width="100%"
                      wrapMode="none"
                      fg={theme().text.base}
                      addedBg={theme().diff.background.added}
                      removedBg={theme().diff.background.removed}
                      contextBg={theme().diff.background.context}
                      addedSignColor={theme().diff.highlight.added}
                      removedSignColor={theme().diff.highlight.removed}
                      lineNumberFg={theme().diff.lineNumber.text}
                      lineNumberBg={theme().diff.background.context}
                      addedLineNumberBg={theme().diff.lineNumber.background.added}
                      removedLineNumberBg={theme().diff.lineNumber.background.removed}
                    />
                  )}
                </Show>
              </scrollbox>
            </box>

            <box height={1} flexShrink={0} backgroundColor={theme().border.base} />
            <box flexShrink={0} paddingTop={1}>
              <text fg={levelColor(theme(), 3)}>
                <b>Reasoning</b>
              </text>
            </box>
            <box flexGrow={1} flexBasis={0} minHeight={0}>
              <scrollbox flexGrow={1} minHeight={0} horizontalScrollbarOptions={{ visible: false }}>
                <text fg={theme().text.base}>{value().step.reasoning || "(no reasoning captured for this step)"}</text>
              </scrollbox>
            </box>
          </>
        )}
      </Show>
    </box>
  )
}

function Commands(props: { context: Plugin.Context }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "session.changes",
        title: "Open change detail",
        slash: { name: "changes" },
        group: "Session",
        palette: true,
        enabled: () => props.context.ui.router.current().type === "session",
        run() {
          props.context.ui.panel.open("changes", { presentation: "panel" })
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "opencode.changes",
  setup(context) {
    context.ui.slot({
      prepend: "sidebar.content",
      render: (props) => <TaskTree context={context} sessionID={props.sessionID} />,
    })
    context.ui.slot({
      append: "session.panel",
      render: (props) => (
        <Show when={props.name === "changes"}>
          <ChangeDetail context={context} input={props} />
        </Show>
      ),
    })
    context.ui.slot({ append: "app", render: () => <History context={context} /> })
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
