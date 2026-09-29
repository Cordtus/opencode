# TUI changes panel (V2)

A change-inspection surface for the V2 TUI: a task tree in the sidebar and a right-hand detail panel showing a selected
change's diff, the reasoning that produced it, and an Undo action.

## Why the task tree is derived, not stored

V2 removed the todo model entirely: `REMOVED_TOOLS = ["todowrite"]`
(`packages/core/src/database/v1-migration.bun.ts`), there is no `session.todo` event/schema/client accessor, and the v1
sidebar todo plugin is gone. There is no plan to attach changes to.

The closest durable unit is the **logical step = one assistant message** (`SessionMessageAssistant`). A step's changes are
the `edit` / `write` / `apply_patch` tool calls in that message's `content`; its reasoning is the message's reasoning
parts. `deriveSteps` in `packages/tui/src/feature-plugins/system/changes-model.ts` does this purely and is unit-tested.

## Components

- `feature-plugins/system/changes-model.ts` — pure `deriveSteps(messages)`; change extraction from tool metadata
  (`metadata.files` preferred, then `metadata.diff`, then a patchless `write`).
- `feature-plugins/system/changes.tsx` — the `opencode.changes` built-in plugin:
  - `prepend` on `sidebar.content` → `TaskTree` (expand a step to its changes; click a change to select).
  - `append` on `session.panel` → `ChangeDetail` (diff top half, reasoning bottom half, both scrollable; Undo).
  - `append` on `app` → `Commands`, which registers `session.changes` (keybind `<leader>d`, slash `/changes`) that opens
    the panel.
- Registered in `plugin/builtins.ts`; keybind default in `config/keybind.ts`.

Selection is client-local module state keyed by `{ sessionID, changeID }` so it cannot leak across sessions.

## Panel reuse

The V2 panel infrastructure (`context/panel.tsx`, `component/panel-host.tsx`, the `session.panel` slot) already existed
but had no shipped consumer before this. `ui.panel.open(name)` selects a panel; the host swaps the right pane between
sidebar, terminal, and panel. Panels are forced fullscreen below ~80 columns (`canSplit`).

## Undo

V2 revert is message-boundary and staged: `client.session.revert.stage({ sessionID, messageID })`. There is no per-file
or per-change undo. The panel's Undo therefore reverts the whole step, using the user message preceding the change's
message as the boundary, and the confirmation dialog states the implications (subsequent file changes roll back and the
conversation from that point is hidden; restore with `/redo`).

## Local development

See `dev-docs/local-development.md` (`opencode-local`).

## History

- 2026-09-29: Retargeted the feature from the `dev` line to V2 (`origin/v2`). Reimplemented against the V2 plugin/panel
  architecture after confirming V2 has no todo model.
