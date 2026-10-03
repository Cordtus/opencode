# TUI changes panel (V2)

A change-inspection surface for the V2 TUI: a task tree in the sidebar and a right-hand detail panel showing a selected
change's diff, the reasoning that produced it, and an Undo action.

## Why the task tree is derived, then accumulated

V2 removed the todo model entirely: `REMOVED_TOOLS = ["todowrite"]`
(`packages/core/src/database/v1-migration.bun.ts`), there is no `session.todo` event/schema/client accessor, and the v1
sidebar todo plugin is gone. There is no plan to attach changes to.

The closest durable unit is the **logical step = one assistant message** (`SessionMessageAssistant`). A step's changes are
the `edit` / `write` / `patch` tool calls in that message's `content`; its reasoning is the message's reasoning parts.
Only steps that produced a change are projected — a step that only read, ran a command, or thought is not a change and is
omitted, along with any prompt left with no such steps. `deriveHistory` in
`packages/tui/src/feature-plugins/system/changes-model.ts` does this purely and is unit-tested.

### Hierarchy

`session (implicit) → prompt (user message) → step (assistant message) → change (file)`

### Persistence (why it is not a live filter)

The client only holds a window of recent messages (`messagePageLimit = 20` in `packages/client/src/solid/data.ts`) and
`evictSession` deletes messages for non-retained sessions. Deriving the tree directly from `message.list()` therefore lost
steps as a session grew ("Step 5" appearing then vanishing and being unrecoverable).

Instead a `History` component (also on the `app` slot) derives the current session and **union-merges** it into a
disk-backed `storage.store("history")`, debounced ~600ms because reasoning streams token-by-token. `mergeHistory` never
removes a change-bearing prompt or step, so the tree is a growing, persistent history that survives the client window and
restarts; it drops steps that produced no change so rows written before this rule age out. Rendering reads the accumulated
store, not `message.list()`.

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
step is still in the client window, then `session.step.diff` for an evicted step, then the working-tree diff as a final git
fallback. A step whose start-to-end range crosses a location switch is rejected (the snapshots live in different
repositories) and shows no diff. `mergeHistory` preserves a legacy `patch` on the persisted change, keyed by change id
instead of array position, so old sessions keep their diffs and the store still ages out of the duplicated patch data as
entries are replaced — no migration needed.

Every request asks for a bounded `context` (three unchanged lines around each hunk). The server treats an omitted `context`
as the whole file, so an unbounded request made selecting a change in a large file render the entire file. The panel's
`PatchDiff` is also given the diff `scrollbox`, which enables its large-added-file virtualization.

### Without git

Snapshot capture requires a git Location, so a non-git project has no snapshot repository and no per-step range. The tree
still derives from `metadata.files` as before, and the panel shows a diff whenever the change carries a stored `patch` or the
step is still in the client window; only an evicted step in a non-git project reports "No diff available for this change."
(Plan changes never have a snapshot diff — plan documents live outside the worktree, so they are not in the captured tree.)

A change whose file lives under the Plan agent's document directory (`<home>/.opencode/plan/`) is tagged `kind: "plan"`.
Read-only work can still update a plan, so a plan edit is the only change a read-only step can produce; the tag lets the
tree and detail header distinguish it from a code change. Detection matches the path convention, not a resolved directory,
because the projection is client-side.

A step whose changes are _all_ plan edits is a planning step: `isPlanStep` marks it, the tree dims its label and adds a
`plan` marker, and the detail panel says the diff is not expected (plan documents live outside the worktree, so no snapshot
diff includes them). A step that changes code is unmarked and expects a diff; when one cannot be resolved the panel says so
plainly, without claiming a diff should have been there.

### Why a code step's diff may not resolve

The ladder tries, in order: legacy patch, live tool patch, `session.step.diff`, then the working-tree diff. A code step
resolves unless every source is empty. The known reasons:

- **Not a git Location, or snapshots disabled** — no snapshot tree exists, so only a live or legacy patch can answer, and
  the working-tree rung is skipped entirely.
- **No recorded snapshot range** — a session predating snapshots, a step with no end snapshot that is not running, or a
  best-effort capture that returned `undefined`.
- **Location switch within the step** — rejected; the two snapshots live in different repositories.
- **The file is gitignored** — the snapshot tree excludes ignored paths, and both the snapshot and working-tree diffs drop
  them, so no diff can exist. This is intentional: ignored files are not tracked.
- **An untracked file larger than 2 MB** — not captured into the snapshot tree.
- **The change is committed (or reverted) and the step has no snapshots** — the working tree is clean, so the final rung is
  empty.
- **Path mismatch** — a Location-relative `change.file` versus a worktree-relative diff path. `matchesFile` handles exact
  paths, a subdirectory Location's prefix, and an absolute `write` input whose resolved diff path is a suffix.
- **Transport/server errors** — a missing location directory (`LocationNotFoundError`), a snapshot error, or a failed
  request; the panel toasts and reports no diff.

The first two and the last two are recoverable in principle; the gitignored and oversized cases are not, because the file is
not in the tracked tree at all.

## Components

- `feature-plugins/system/changes-model.ts` — pure `deriveHistory(messages)` and `mergeHistory(previous, next)`; change
  extraction from `metadata.files`, with a path fallback for `write`.
- `feature-plugins/system/changes.tsx` — the `opencode.changes` built-in plugin:
  - `append` on `app` → `History` (accumulates the durable projection) and `Commands` (registers `session.changes`, keybind
    `<leader>d`, slash `/changes`).
  - `prepend` on `sidebar.content` → `TaskTree` (prompt → step → change; click a change to select).
  - `append` on `session.panel` → `ChangeDetail` (diff top half, reasoning bottom half, both scrollable; Undo).
- Registered in `plugin/builtins.ts`; keybind default in `config/keybind.ts`.
- `ChangeDetail`'s on-demand diff resolution is covered by `test/feature-plugins/changes-detail.test.tsx`
  (the step endpoint path, the bounded-context request, the working-tree fallback, and the legacy-patch short circuit);
  the tree and model have their own tests. `test/util/added-patch.test.ts` covers `splitPatchHunks` on a multi-file patch.

Selection and expansion live in the plugin memory store (`context.storage.memory("state")`), shared between the sidebar and
the panel and surviving hot reloads. Prompts default expanded, steps default collapsed.

Every rendered step produced a change, so every step's disclosure arrow expands to at least one change; the tree never
shows a "no changes" empty state and never shows an inert arrow. `TaskTree` filters the persisted history to change-bearing
steps (and drops prompts left empty) as a second guard, because the store may still hold rows written before this rule.

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
- 2026-09-30: Reversed the inert-arrow rule. Steps and prompts that produced no change are hidden entirely rather than shown
  greyed; `deriveHistory` and `mergeHistory` drop them, so the tree shows only expandable steps.
- 2026-09-30: Plan-directory edits are tagged `kind: "plan"` and rendered with a `plan` marker so a read-only step's only
  possible change is identifiable.
- 2026-09-30: Stopped persisting patches. Diffs load on selection from the new step-scoped snapshot endpoint
  (`session.step.diff`), so history stores only session context and never duplicates snapshot/git data. Exact per-step
  attribution because each step has its own start/end snapshot; project commit boundaries are irrelevant.
- 2026-10-01: Closing the detail panel with `✕` now hands renderer focus back to the prompt (`focusSession`), instead of
  leaving it on the unmounted panel node where the TUI accepted no input. Diff requests ask for a bounded context (three
  lines) and the panel's `PatchDiff` receives its scrollbox, so a change in a large file renders hunks and large added
  files virtualize rather than rendering the whole file. `splitPatchHunks` no longer stalls when a foreign line (a
  multi-file patch's `diff --git` header) reaches a single hunk slice.
- 2026-10-03: The durable projection derives and writes once per debounce and never overlaps whole-store writes, and stores
  a truncated reasoning preview, so a running task cannot pile synchronous read/serialize/write work on the main thread.
  Separately, `@opentui` is bumped to 0.5.14 for the upstream resize memory leak (see the work-in-progress note).
- 2026-10-03: Planning steps are visually separated from code steps. `isPlanStep` marks a step whose every change is a
  plan-document edit; the tree dims its label and shows a `plan` marker, and the detail panel reports "No diff expected"
  rather than a bare no-diff message.
