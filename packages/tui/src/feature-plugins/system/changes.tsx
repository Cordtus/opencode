import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { LocationRef } from "@opencode/client"
import { isInvalidRequestError } from "@opencode/client/promise"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createResource, Index, onCleanup, Show } from "solid-js"
import { useThemes } from "../../context/theme"
import { PatchDiff } from "../../component/patch-diff"
import { filetype } from "../../util/filetype"
import { errorMessage } from "../../util/error"
import {
  deriveHistory,
  diffPatch,
  isPlanStep,
  legacyPatch,
  livePatch,
  mergeHistory,
  type SessionChange,
  type SessionPrompt,
  type SessionStep,
} from "./changes-model"

type Selection = { sessionID: string; changeID: string }

// The server treats an omitted `context` as the whole file. Ask for the change plus a few
// surrounding lines so selecting a change in a large file renders hunks, not the entire file.
const DIFF_CONTEXT_LINES = 3

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
 * Accumulates `deriveHistory` output into durable storage. The transcript is only tracked so a
 * change schedules a projection: deriving and writing happen once per debounce rather than once
 * per streamed token, and writes never overlap. Without that, a running task makes the
 * whole-store read/serialize/write (and the watcher reload it triggers) pile up on the main
 * thread. The union-merge means evicted messages stay in the tree.
 */
function History(props: { context: Plugin.Context }) {
  const history = props.context.storage.store<HistoryStore>("history", HistoryStoreOptions)
  const update = history[1]
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let dirty: string | undefined

  const schedule = () => {
    if (timer || running) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, 600)
  }
  const flush = async () => {
    if (running || !dirty) return
    const sessionID = dirty
    dirty = undefined
    const prompts = deriveHistory(props.context.data.session.message.list(sessionID))
    if (!prompts.length) return
    running = true
    try {
      await update((draft) => {
        draft.sessions[sessionID] = mergeHistory(draft.sessions[sessionID], prompts)
      })
    } catch {
      // A failed write is retried by the next scheduled flush; keep the panel usable.
    }
    running = false
    if (dirty) schedule()
  }
  createEffect(() => {
    const route = props.context.ui.router.current()
    if (route.type !== "session") return
    const messages = props.context.data.session.message.list(route.sessionID)
    if (!messages.length) return
    dirty = route.sessionID
    schedule()
  })
  onCleanup(() => {
    if (timer) clearTimeout(timer)
    void flush()
  })
  return null
}

export function TaskTree(props: { context: Plugin.Context; sessionID: string }) {
  const theme = () => props.context.theme
  const history = props.context.storage.store<HistoryStore>("history", HistoryStoreOptions)
  // Render only change-bearing steps. History may still hold rows written before this rule
  // (or a step still in flight), so filter here rather than trusting the persisted shape.
  const prompts = createMemo(() =>
    (history[0].sessions[props.sessionID] ?? []).flatMap((prompt) => {
      const steps = prompt.steps.filter((step) => step.changes.length > 0)
      return steps.length > 0 ? [{ ...prompt, steps }] : []
    }),
  )
  const memory = props.context.storage.memory<ChangesMemory>("state", MemoryOptions)[0]
  const update = props.context.storage.memory<ChangesMemory>("state", MemoryOptions)[1]
  // Ignored paths never enter a tracked tree, so their changes can never have a diff. Ask the
  // provider once per session so the tree can separate "no tracked diff" from "diff not loaded".
  const [ignoredPaths] = createResource(
    () => props.context.data.session.get(props.sessionID)?.location ?? props.context.data.location.default(),
    async (location) => {
      const paths = (history[0].sessions[props.sessionID] ?? []).flatMap((prompt) =>
        prompt.steps.flatMap((step) => step.changes.map((change) => change.file)),
      )
      if (!paths.length) return new Set<string>()
      try {
        return new Set((await props.context.client.vcs.ignored({ location, paths })).data)
      } catch {
        return new Set<string>()
      }
    },
  )
  const isIgnored = (file: string) => ignoredPaths()?.has(file) ?? false

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
                              <Show when={isPlanStep(step())}>
                                <text flexShrink={0} fg={theme().text.muted}>
                                  plan
                                </text>
                              </Show>
                              <text
                                flexGrow={1}
                                wrapMode="word"
                                fg={isPlanStep(step()) ? theme().text.muted : levelColor(theme(), 1)}
                              >
                                {step().label}
                              </text>
                            </box>
                            <Show when={stepExpanded()}>
                              <box paddingLeft={2}>
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
                                      <Show when={change().kind === "plan"}>
                                        <text flexShrink={0} fg={theme().text.muted}>
                                          plan
                                        </text>
                                      </Show>
                                      <Show when={isIgnored(change().file)}>
                                        <text flexShrink={0} fg={theme().text.muted}>
                                          untracked
                                        </text>
                                      </Show>
                                      <text
                                        flexGrow={1}
                                        wrapMode="word"
                                        fg={
                                          selected(change().id)
                                            ? theme().text.base
                                            : isIgnored(change().file)
                                              ? theme().text.muted
                                              : levelColor(theme(), 2)
                                        }
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

/** A resolved diff, or the reason there is none: `untracked` means every tracked-tree source
 * answered without the file, so it is not tracked at all (gitignored, outside the worktree, or
 * over the snapshot's untracked size limit) or the change is already gone. */
type DiffResult = { readonly patch?: string; readonly untracked?: boolean }

/** Exact per-step diff from the step's own start/end snapshots. A location-spanning step is a
 * rejection, not an error worth toasting, so it degrades to the next source. */
async function stepDiff(context: Plugin.Context, sessionID: string, change: SessionChange) {
  try {
    const diffs = await context.client.session.step.diff({
      sessionID,
      messageID: change.messageID,
      context: DIFF_CONTEXT_LINES,
    })
    return diffPatch(diffs, change)
  } catch (error) {
    if (isInvalidRequestError(error)) return undefined
    context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    return undefined
  }
}

/** Git diff of the file: HEAD vs the working copy (`working`), or the branch base vs the working
 * copy (`branch`). The branch rung is the least precise — it also sees earlier commits — but it is
 * the only source for a committed change in a step with no snapshots. */
async function gitDiff(
  context: Plugin.Context,
  location: LocationRef,
  change: SessionChange,
  mode: "working" | "branch",
) {
  try {
    const result = await context.client.vcs.diff({ location, mode, context: DIFF_CONTEXT_LINES })
    return diffPatch(result.data ?? [], change)
  } catch (error) {
    // The branch rung is a last resort; a repository without a default branch should not toast.
    if (mode === "working") context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    return undefined
  }
}

export function ChangeDetail(props: { context: Plugin.Context; input: PanelInput }) {
  const theme = () => props.context.theme
  const { currentSyntax } = useThemes()
  let diffScroll: ScrollBoxRenderable | undefined
  onCleanup(() => (diffScroll = undefined))
  const history = props.context.storage.store<HistoryStore>("history", HistoryStoreOptions)
  const memory = props.context.storage.memory<ChangesMemory>("state", MemoryOptions)[0]
  const current = createMemo<{ step: SessionStep; change: SessionChange } | undefined>(() => {
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
  // The durable history stores no patches: the diff lives in the snapshot repository, so it is
  // loaded per step on selection rather than duplicated per change. `/redo` keeps a legacy step's
  // stored patch, and a step still in this client's window keeps its tool result's patch.
  const selected = createMemo(() => current()?.change)
  const sessionLocation = () =>
    props.context.data.session.get(props.input.sessionID)?.location ?? props.context.data.location.default()
  const [patch] = createResource(
    () => selected()?.id,
    async (id): Promise<DiffResult | undefined> => {
      const change = selected()
      if (!change || change.id !== id) return undefined
      // Every source below is a way to reach the same diff. Prefer the most precise one that is
      // available, and never leave the panel empty when any source can answer.
      const legacy = legacyPatch(change)
      if (legacy) return { patch: legacy }
      const live = livePatch(props.context.data.session.message.get(props.input.sessionID, change.messageID), change)
      if (live) return { patch: live }
      const location = sessionLocation()
      if (props.context.data.location.vcs.info(location)?.provider !== "git") return {}
      // Exact per-step snapshot diff, then the working tree, then the branch base.
      const step = await stepDiff(props.context, props.input.sessionID, change)
      if (step) return { patch: step }
      const working = await gitDiff(props.context, location, change, "working")
      if (working) return { patch: working }
      const branch = await gitDiff(props.context, location, change, "branch")
      if (branch) return { patch: branch }
      // Every tracked-tree source answered without this file.
      return { untracked: true }
    },
  )

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
              <Show when={value().change.kind === "plan"}>
                <text fg={theme().text.muted}>[plan]</text>
              </Show>
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
              <scrollbox
                ref={(element: ScrollBoxRenderable) => (diffScroll = element)}
                flexGrow={1}
                minHeight={0}
                horizontalScrollbarOptions={{ visible: false }}
              >
                <Show
                  when={!patch.loading && patch()?.patch}
                  fallback={
                    <text fg={theme().text.muted}>
                      {patch.loading
                        ? "Loading diff…"
                        : value().change.kind === "plan"
                          ? "No diff expected (plan document)."
                          : patch()?.untracked
                            ? "No diff expected (the file is not in a tracked tree)."
                            : "No diff available for this change."}
                    </text>
                  }
                >
                  {(text) => (
                    <PatchDiff
                      diff={text()}
                      scroll={() => diffScroll}
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
