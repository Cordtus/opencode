# Work in progress

Current scope and remaining tasks for the changes-panel work on the `integration` branch. Update or delete this file as
the work lands; durable behavior belongs in `dev-docs/tui-changes-panel.md`.

## State

- Branch `integration`, tracking `fork/integration`.
- Committed and pushed: `8d5b334992` (read-only step distinction + on-demand step diffs), `35e8a54635` (show only
  change-bearing steps), plus prior panel history.
- **Uncommitted working-tree changes** (this session) close out the reported issues: the panel `✕` focus hand-off,
  bounded-context diffs + large-added-file virtualization, and a `splitPatchHunks` infinite-loop guard. Focused tests and
  `bun typecheck` pass; the root `bun run check` ship gate has not been re-run.

## Scope: make a diff always resolvable

The panel must never show "No diff available" when any source can answer. Resolution is an ordered ladder, most precise
first, reusing existing endpoints — no new server surface:

1. **Legacy stored `patch`** — preserved on the persisted change (`legacyPatch`), for `/redo` and pre-snapshot history.
2. **Live tool result** — `metadata.files[].patch` when the step is still in the client message window (`livePatch`).
3. **Step snapshot diff** — `client.session.step.diff` (`SessionDiff.step`), exact per-step start/end snapshots.
4. **Working-tree diff** — `client.vcs.diff({ location, mode: "working" })`, the final git fallback; always available in
   a git repo so a diff is shown even when snapshots are missing (pre-snapshot sessions, evicted steps).
5. **No git** — the only case with no source; the panel reports that honestly.

Patch selection is centralized in `diffPatch(diffs, change)` (Location-relative vs worktree-relative match), so every
source picks the same file the same way.

### In-flight edits (uncommitted)

- `packages/tui/src/feature-plugins/system/changes.tsx`
  - `ChangeDetail` resource rewritten to the ladder above; `stepDiff` / `workingDiff` helpers added above `ChangeDetail`.
  - Both requests pass a bounded `context` (`DIFF_CONTEXT_LINES = 3`); `workingDiff` toasts on a real failure instead of
    reading as "no diff". `PatchDiff` receives the panel scrollbox so large added files virtualize.
  - Import updated: `matchesFile` dropped, `diffPatch` and `LocationRef` added; `ScrollBoxRenderable` added.
- `packages/tui/src/feature-plugins/system/changes-model.ts`
  - Added `diffPatch(diffs, change)` export.
- `packages/tui/src/util/diff.ts`
  - `splitRows` treats any non-`+`/`-`/`\` line as context so a foreign line can never stall the loop.
- `packages/tui/src/component/session-frame.tsx`
  - Panel close (`onTarget(undefined)`) now calls `focusSession()` instead of `setActivePane("session")`, so closing the
    detail panel with the `✕` hands renderer focus back to the prompt. Previously focus stayed on the unmounted panel
    node and the TUI accepted no input.

## Remaining tasks

1. **Commit and push** to `fork/integration`. `bun run check` (root, lint + typecheck), the core/server diff tests, and
   the TUI feature-plugins/util tests all pass. `test/feature-plugins/changes-panel-focus.test.tsx` covers the `✕` path
   end to end (open from the sidebar, fullscreen, close, prompt accepts input); note it does not fail on the old
   `setActivePane("session")` code in the test renderer, which restores focus on its own.

## Memory / freeze follow-up

A kernel OOM on 2026-09-28 killed an installed `opencode` TUI (channel `latest`, before the panel was committed) at
~10.4 GB RSS + ~58 GB swap. The fork's own unbounded structure is the changes `history` store: `mergeHistory` never evicts
and the whole store is re-serialized on every ~600 ms flush and on every `fs.watch` reload, so it is O(n²) in retained
steps. It is not large today (1.8 MB / 919 steps), so it does not explain that OOM on its own; bounding it (truncate stored
reasoning, cap retained steps/sessions) is a deliberate design change that needs sign-off before it lands.

### Resize crash (2026-10-03)

Resizing the TUI while a task ran froze it and drove memory into the tens of GB. Root cause is upstream in `@opentui`, not
the fork: `CodeRenderable` text updates leaked the replaced text-buffer rope (~1.24 MB per 2000-line update), and resize
reallocated every cell array. `@opentui` 0.5.13 released the rope ("release replaced text buffer ropes") and reuses buffers
while cells fit ("resize buffers in place"); 0.5.14 also repaints after net-zero resize bursts. The fork pinned 0.5.12, so
this bumps `@opentui/core|keymap|solid` to 0.5.14 (see `dev-docs/tui-changes-panel.md`). Verified by a direct guard:
300 `CodeRenderable` text updates grew RSS ~390 MB on 0.5.12 and ~14 MB on 0.5.14.

Separately, the changes `History` now derives and writes once per debounce and never overlaps whole-store writes, and
truncates stored reasoning to a preview, so a running task cannot pile synchronous read/serialize/write work on the main
thread.

## Open questions / decisions

- The README edit is an uncommitted tracked change; the git working-tree fallback will show it only once it is a real
  working-tree diff. Confirm that is the intended behavior for "recent edits to README.md".
- `workingDiff` uses `mode: "working"` (HEAD vs working copy). If a change is already committed, that fallback returns
  nothing for it; decide whether a `committed`/`branch` mode fallback is also needed or whether the snapshot step diff
  already covers committed steps.
