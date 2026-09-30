# TUI changes panel (V2)

A change-inspection surface for the V2 TUI: a task tree in the sidebar and a right-hand detail panel showing a selected
change's diff, the reasoning that produced it, and an Undo action.

## Why the task tree is derived, then accumulated

V2 removed the todo model entirely: `REMOVED_TOOLS = ["todowrite"]`
(`packages/core/src/database/v1-migration.bun.ts`), there is no `session.todo` event/schema/client accessor, and the v1
sidebar todo plugin is gone. There is no plan to attach changes to.

The closest durable unit is the **logical step = one assistant message** (`SessionMessageAssistant`). A step's changes are
the `edit` / `write` / `patch` tool calls in that message's `content`; its reasoning is the message's reasoning parts.
`deriveHistory` in `packages/tui/src/feature-plugins/system/changes-model.ts` does this purely and is unit-tested.

### Hierarchy

`session (implicit) → prompt (user message) → step (assistant message) → change (file)`

### Persistence (why it is not a live filter)

The client only holds a window of recent messages (`messagePageLimit = 20` in `packages/client/src/solid/data.ts`) and
`evictSession` deletes messages for non-retained sessions. Deriving the tree directly from `message.list()` therefore lost
steps as a session grew ("Step 5" appearing then vanishing and being unrecoverable), and completed steps with no changes
were filtered out.

Instead a `History` component (also on the `app` slot) derives the current session and **union-merges** it into a
disk-backed `storage.store("history")`, debounced ~600ms because reasoning streams token-by-token. `mergeHistory` never
removes prompts or steps, so the tree is a growing, persistent history that survives the client window and restarts.
Rendering reads the accumulated store, not `message.list()`.

The projection grows as the transcript's own pagination loads older pages; there is no eager full-session fetch, so
opening a session does not issue extra message requests.

Change identity comes from `metadata.files` (the canonical `FileDiff.Info`: `file`, `additions`, `deletions`, `status`).
The patch is **not** stored: the snapshot repository already holds it, so the durable projection keeps only session context
(which step, which file, counts, plan tag). `write` returns only `output`/`content` and never persists a diff, so a `write`
change has no reported status. Only completed tool calls contribute changes.

The diff itself is loaded on selection from `session.step.diff`
(`GET /api/session/:sessionID/step/:messageID/diff`, backed by `SessionDiff.step`), which compares the assistant message's
own `snapshot.start`→`snapshot.end` trees. That is exact per-step attribution: sibling steps are never merged, so a project
commit that bundles several steps does not blur them. A step still running compares against the working copy; a session
predating snapshots yields no diffs. A change's `file` is Location-relative while a snapshot diff path is worktree-relative,
so the panel matches exact first and falls back to a path suffix for subdirectory Locations. Diffs are resolved in order
without duplication: a legacy stored `patch` (`/redo` restores one), then the live tool result's `metadata.files` when the
step is still in the client window, then `session.step.diff` for an evicted step. A step whose start-to-end range crosses a
location switch is rejected (the snapshots live in different repositories) and shows no diff. `mergeHistory` preserves a
legacy `patch` on the persisted change, keyed by change id instead of array position, so old sessions keep their diffs and
the store still ages out of the duplicated patch data as entries are replaced — no migration needed.

### Without git

Snapshot capture requires a git Location, so a non-git project has no snapshot repository and no per-step range. The tree
still derives from `metadata.files` as before, and the panel shows a diff whenever the change carries a stored `patch` or the
step is still in the client window; only an evicted step in a non-git project reports "No diff available for this change."
(Plan changes never have a snapshot diff — plan documents live outside the worktree, so they are not in the captured tree.)

A change whose file lives under the Plan agent's document directory (`<home>/.opencode/plan/`) is tagged `kind: "plan"`.
Read-only work can still update a plan, so a plan edit is the only change a read-only step can produce; the tag lets the
tree and detail header distinguish it from a code change. Detection matches the path convention, not a resolved directory,
because the projection is client-side.

## Components

- `feature-plugins/system/changes-model.ts` — pure `deriveHistory(messages)` and `mergeHistory(previous, next)`; change
  extraction from `metadata.files`, with a path fallback for `write`.
- `feature-plugins/system/changes.tsx` — the `opencode.changes` built-in plugin:
  - `append` on `app` → `History` (accumulates the durable projection) and `Commands` (registers `session.changes`, keybind
    `<leader>d`, slash `/changes`).
  - `prepend` on `sidebar.content` → `TaskTree` (prompt → step → change; click a change to select).
  - `append` on `session.panel` → `ChangeDetail` (diff top half, reasoning bottom half, both scrollable; Undo).
- Registered in `plugin/builtins.ts`; keybind default in `config/keybind.ts`.

Selection and expansion live in the plugin memory store (`context.storage.memory("state")`), shared between the sidebar and
the panel and surviving hot reloads. Prompts default expanded, steps default collapsed.

A step is only expandable when it actually produced a change. Read-only steps (a tool call that made no file modification)
keep their disclosure arrow but render it in `text.formfield.disabled` and ignore the toggle, so the tree distinguishes
"this step did work" from "this step produced changes" without hiding the step. The panel never shows a "no changes" empty
state: an expanded step always has at least one change to list.

## Presentation

Tiers are distinguished by the **categorical** palette (`theme.categorical[level][300]`), by semantic role rather than
literal color: prompt → `[0]`, step → `[1]`, change/file and the panel's "Diff" label → `[2]`, panel's "Reasoning" label →
`[3]`. Step status uses `text.feedback` (`success`/`warning`/`error`, which are genuine outcome states); file A/M/D marks
and `+/-` counts use the `diff` tokens; the Undo action uses `text.action.destructive`. The detail panel has a thin
`border.base` left edge, 1-row `border.base` separators between its header, diff, and reasoning sections, and a colored
`▍` accent on the file name. Per `packages/tui/AGENTS.md`, no unrelated token is repurposed.

## Panel reuse

The V2 panel infrastructure (`context/panel.tsx`, `component/panel-host.tsx`, the `session.panel` slot) already existed
but had no shipped consumer before this. `ui.panel.open(name)` selects a panel; the host swaps the right pane between
sidebar, terminal, and panel. Panels are forced fullscreen below ~80 columns (`canSplit`).

## Undo

V2 revert is message-boundary and staged: `client.session.revert.stage({ sessionID, messageID })`. Staging is rejected
while the session is executing, so the panel interrupts and waits first when the status is `running`. There is no
per-file or per-change undo. The panel's Undo therefore reverts the whole step, using the user message preceding the
change's message as the boundary, and the confirmation dialog states the implications (subsequent file changes roll back
and the conversation from that point is hidden; restore with `/redo`).

## Local development

See `dev-docs/local-development.md` (`opencode-local`).

## History

- 2026-09-28: Retargeted the feature from the `dev` line to V2 (`origin/v2`). Reimplemented against the V2 plugin/panel
  architecture after confirming V2 has no todo model.
- 2026-09-29: Steps no longer vanish. The tree is now an accumulated, disk-backed projection (`deriveHistory` +
  `mergeHistory`) nested as session → prompt → step → change, because the client only windows the last ~20 messages.
- 2026-09-30: Read-only steps keep a greyed, inert disclosure arrow instead of expanding to an empty "no changes" state;
  only steps that produced a change expand.
- 2026-09-30: Plan-directory edits are tagged `kind: "plan"` and rendered with a `plan` marker so a read-only step's only
  possible change is identifiable.
- 2026-09-30: Stopped persisting patches. Diffs load on selection from the new step-scoped snapshot endpoint
  (`session.step.diff`), so history stores only session context and never duplicates snapshot/git data. Exact per-step
  attribution because each step has its own start/end snapshot; project commit boundaries are irrelevant.
