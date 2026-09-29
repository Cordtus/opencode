import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { createMemo, Index, Show } from "solid-js"
import { useThemes } from "../../context/theme"
import { PatchDiff } from "../../component/patch-diff"
import { filetype } from "../../util/filetype"
import { errorMessage } from "../../util/error"
import type { SessionMessageInfo } from "@opencode/client"
import { deriveSteps, type SessionChange } from "./changes-model"

type Selection = { sessionID: string; changeID: string }

// Client-local UI state shared by the sidebar tree and the panel. The plugin memory
// store keeps both views in sync and survives plugin hot reloads.
type ChangesMemory = { expanded: Record<string, boolean>; selection?: Selection }

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

export function TaskTree(props: { context: Plugin.Context; sessionID: string }) {
  const theme = () => props.context.theme
  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const steps = createMemo(() => deriveSteps(messages()))
  const [memory, updateMemory] = props.context.storage.memory<ChangesMemory>("state", { initial: { expanded: {} } })

  const markFg = (change: SessionChange) => {
    if (change.status === "added") return theme().diff.text.added
    if (change.status === "deleted") return theme().diff.text.removed
    return theme().text.muted
  }
  const selected = (id: string) => memory.selection?.sessionID === props.sessionID && memory.selection?.changeID === id
  const open = (change: SessionChange) => {
    updateMemory((draft) => {
      draft.selection = { sessionID: props.sessionID, changeID: change.id }
    })
    props.context.ui.panel.open("changes", { presentation: "panel" })
  }

  return (
    <Show when={steps().length > 0}>
      <box>
        <text fg={theme().text.base}>
          <b>Changes</b>
        </text>
        <Index each={steps()}>
          {(step) => (
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() =>
                  updateMemory((draft) => {
                    draft.expanded[step().id] = !(draft.expanded[step().id] ?? false)
                  })
                }
              >
                <text fg={theme().text.muted}>{memory.expanded[step().id] ? "▼" : "▶"}</text>
                <text flexGrow={1} wrapMode="word" fg={theme().text.base}>
                  [{statusMark(step().status)}] {step().label}
                </text>
              </box>
              <Show when={memory.expanded[step().id]}>
                <box paddingLeft={2}>
                  <Show
                    when={step().changes.length > 0}
                    fallback={<text fg={theme().text.muted}>No changes yet.</text>}
                  >
                    <Index each={step().changes}>
                      {(change) => (
                        <box
                          flexDirection="row"
                          gap={1}
                          onMouseUp={() => open(change())}
                          backgroundColor={selected(change().id) ? theme().background.raised.high : undefined}
                        >
                          <text flexShrink={0} fg={markFg(change())}>
                            {changeMark(change().status)}
                          </text>
                          <text
                            flexGrow={1}
                            wrapMode="word"
                            fg={selected(change().id) ? theme().text.base : theme().text.muted}
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
          )}
        </Index>
      </box>
    </Show>
  )
}

function ChangeDetail(props: { context: Plugin.Context; input: PanelInput }) {
  const theme = () => props.context.theme
  const { currentSyntax } = useThemes()
  const messages = createMemo(() => props.context.data.session.message.list(props.input.sessionID))
  const [memory, updateMemory] = props.context.storage.memory<ChangesMemory>("state", { initial: { expanded: {} } })
  const current = createMemo(() => {
    const selection = memory.selection
    if (!selection || selection.sessionID !== props.input.sessionID) return
    for (const step of deriveSteps(messages())) {
      const change = step.changes.find((item) => item.id === selection.changeID)
      if (change) return { step, change }
    }
    return
  })

  const close = () => {
    updateMemory((draft) => {
      draft.selection = undefined
    })
    props.input.close()
  }

  const undo = async (change: SessionChange) => {
    const list = messages()
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
      updateMemory((draft) => {
        draft.selection = undefined
      })
      props.context.ui.toast.show({ message: `Reverted step containing ${change.file}`, variant: "success" })
    } catch (error) {
      props.context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    }
  }

  return (
    <box flexGrow={1} minWidth={0} flexDirection="column">
      <Show
        when={current()}
        fallback={
          <text fg={theme().text.muted}>Select a change in the sidebar to inspect its diff and reasoning.</text>
        }
      >
        {(value) => (
          <>
            <box flexDirection="row" gap={1} flexShrink={0}>
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

            <box flexShrink={0} paddingTop={1}>
              <text fg={theme().text.muted}>
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
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
