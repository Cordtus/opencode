import type {
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageUser,
} from "@opencode/client"
import { canonicalToolName, finiteNumber, toolDisplayMetadata } from "../../util/tool-display"

export type SessionChange = {
  id: string
  file: string
  additions: number
  deletions: number
  /** Absent when the producer did not report one (e.g. `write`). */
  status?: "added" | "deleted" | "modified"
  /**
   * `"plan"` marks an edit to the Plan agent's document directory. It is still a change, but
   * read-only work only ever produces this kind, so the panel can tell a plan update from a
   * code change.
   */
  kind?: "plan"
  messageID: string
}

/**
 * A legacy change whose `patch` was persisted before diffs moved to the snapshot repository.
 * `deriveHistory` never produces it; it ages out of the store as steps are re-projected.
 */
export type PersistedChange = SessionChange & { patch?: string }

export function legacyPatch(change: SessionChange): string | undefined {
  const patch = (change as PersistedChange).patch
  return typeof patch === "string" && patch.length > 0 ? patch : undefined
}

export type SessionStep = {
  /** Assistant message ID; one logical step per assistant message. */
  id: string
  label: string
  status: "running" | "error" | "done"
  reasoning: string
  changes: SessionChange[]
}

export type SessionPrompt = {
  /** User message ID, or `prompt:start` for steps before the first prompt. */
  id: string
  label: string
  steps: SessionStep[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

/** Read a string field from an unknown record; used for tool `metadata.files` entries. */
function stringField(value: unknown, key: string) {
  const object = record(value)
  return object ? stringValue(object[key]) : undefined
}

function truncate(value: string, length = 72) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

function firstLine(value: string) {
  return value
    .split("\n")
    .find((line) => line.trim())
    ?.trim()
}

type PatchFile = {
  file: string
  additions: number
  deletions: number
  status?: SessionChange["status"]
}

// ponytail: PlanPlugin writes plan documents under `<home>/.opencode/plan`; match that path
// convention rather than plumbing the resolved directory into this client-side projection.
function isPlanFile(file: string) {
  const normalized = file.replaceAll("\\", "/")
  return normalized.startsWith(".opencode/plan/") || normalized.includes("/.opencode/plan/")
}

/**
 * Match a snapshot diff path (worktree-relative) to a change's `file` (Location-relative).
 * A subdirectory Location prefixes the diff path, so exact match wins and a path suffix is
 * the fallback.
 */
export function matchesFile(diffFile: string, changeFile: string) {
  const target = changeFile.replaceAll("\\", "/").replace(/^\.\//, "")
  return diffFile === target || diffFile.endsWith(`/${target}`)
}

/**
 * A change's diff when its step is still in the client message window: the completed tool
 * result's `metadata.files` entry for the same file. `undefined` once the message is evicted.
 */
export function livePatch(message: SessionMessageInfo | undefined, change: SessionChange) {
  const content = message?.type === "assistant" ? message.content : undefined
  const file = content
    ?.flatMap((part) => (part.type === "tool" ? toolDisplayMetadata(part.state).files : []))
    .find((entry) => matchesFile(stringField(entry, "file") ?? "", change.file))
  return stringField(file, "patch")
}

/** The `patch` for `change.file` in a `FileDiff.Info` list, matching Location- or worktree-relative paths. */
export function diffPatch(diffs: readonly { file: string; patch?: string }[], change: SessionChange) {
  const match =
    diffs.find((diff) => diff.file === change.file) ?? diffs.find((diff) => matchesFile(diff.file, change.file))
  return match?.patch
}

/** `metadata.files` is the canonical `FileDiff.Info` list emitted by edit/patch. */
function parsePatchFiles(value: unknown): PatchFile[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = record(item)
    if (!file) return []
    const path = stringValue(file.file)
    if (!path) return []
    const status = stringValue(file.status)
    return [
      {
        file: path,
        additions: finiteNumber(file.additions) ?? 0,
        deletions: finiteNumber(file.deletions) ?? 0,
        status: status === "added" || status === "deleted" || status === "modified" ? status : undefined,
      },
    ]
  })
}

/** A change is a completed file-producing tool call: edit/patch (metadata.files) or write. */
function changesFromTool(part: SessionMessageAssistantTool, messageID: string): SessionChange[] {
  if (part.state.status !== "completed") return []

  const files = parsePatchFiles(toolDisplayMetadata(part.state).files)
  if (files.length) {
    return files.map((file, index) => ({
      id: `${part.id}:${index}`,
      file: file.file,
      additions: file.additions,
      deletions: file.deletions,
      status: file.status,
      kind: isPlanFile(file.file) ? ("plan" as const) : undefined,
      messageID,
    }))
  }

  // `write` returns output/content only; its diff is never persisted on the tool result.
  if (canonicalToolName(part.name) === "write") {
    const file = stringValue(part.state.input.path)
    if (file) {
      return [
        {
          id: `${part.id}:0`,
          file,
          additions: 0,
          deletions: 0,
          kind: isPlanFile(file) ? "plan" : undefined,
          messageID,
        },
      ]
    }
  }

  return []
}

function stepLabel(message: SessionMessageAssistant, index: number) {
  const first = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .map(firstLine)
    .find(Boolean)
  return first ? truncate(first) : `Step ${index}`
}

function promptLabel(message: SessionMessageUser, index: number) {
  const first = firstLine(message.text)
  return first ? truncate(first) : `Prompt ${index}`
}

/**
 * V2 removed the todo model and the `todowrite` tool, so there is no plan to attach
 * changes to. The closest durable unit is the logical step = one assistant message
 * (`SessionMessageAssistant`), nested under the user prompt that started it.
 *
 * Only steps that produced a change are projected; a step that merely read, ran a
 * command, or thought is not a change and must not appear in the tree.
 */
export function deriveHistory(messages: SessionMessageInfo[]): SessionPrompt[] {
  const prompts: SessionPrompt[] = []
  let prompt: SessionPrompt | undefined
  let promptIndex = 0
  let stepIndex = 0

  const ensurePrompt = () => {
    if (prompt) return prompt
    promptIndex++
    prompt = { id: "prompt:start", label: `Session start`, steps: [] }
    prompts.push(prompt)
    return prompt
  }

  for (const message of messages) {
    if (message.type === "user") {
      promptIndex++
      stepIndex = 0
      prompt = { id: message.id, label: promptLabel(message, promptIndex), steps: [] }
      prompts.push(prompt)
      continue
    }
    if (message.type !== "assistant") continue

    const changes = message.content.flatMap((part) => (part.type === "tool" ? changesFromTool(part, message.id) : []))
    // A step with no file-producing change is not a change: it would only add an inert,
    // unexpandable row. Keep the tree to steps that actually produced something.
    if (changes.length === 0) continue
    const reasoning = message.content
      .flatMap((part) => (part.type === "reasoning" ? [part.text] : []))
      .filter(Boolean)
      .join("\n\n")

    stepIndex++
    ensurePrompt().steps.push({
      id: message.id,
      label: stepLabel(message, stepIndex),
      status: message.error ? "error" : message.time.completed === undefined ? "running" : "done",
      reasoning,
      changes,
    })
  }

  return prompts.filter((prompt) => prompt.steps.length > 0)
}

/**
 * Union-merge a freshly derived history into the accumulated one. Steps that produced a
 * change and prompts that contain them are never removed: once the client message window
 * (last ~20) drops a message, the persisted copy is the only remaining record. A step with
 * no change is dropped here so history written before this rule ages out of the tree.
 *
 * Patches are not part of the derived projection, but a legacy row may still carry one. It is
 * preserved as-is: only the diff is retained, never re-added, so the store ages out of the
 * duplicated patch data as entries are replaced without forcing a refetch for old steps.
 */
export function mergeHistory(previous: SessionPrompt[] | undefined, next: SessionPrompt[]): SessionPrompt[] {
  if (!previous?.length) return next

  const prompts = new Map(previous.map((prompt) => [prompt.id, prompt]))
  const order = previous.map((prompt) => prompt.id)
  for (const incoming of next) {
    const existing = prompts.get(incoming.id)
    if (!existing) {
      if (incoming.steps.length === 0) continue
      prompts.set(incoming.id, incoming)
      order.push(incoming.id)
      continue
    }
    existing.label = incoming.label
    const steps = new Map(existing.steps.map((step) => [step.id, step]))
    for (const step of incoming.steps) {
      const prior = steps.get(step.id)
      if (!prior) {
        existing.steps.push(step)
        continue
      }
      prior.label = step.label
      prior.status = step.status
      prior.reasoning = step.reasoning
      // A legacy `patch` is preserved on the persisted object (never on the derived change
      // shape), keyed by change id so a mixed patch/no-patch history survives re-projection.
      const legacy = new Map(
        prior.changes.flatMap((change) => {
          const patch = legacyPatch(change)
          return patch ? [[change.id, patch] as const] : []
        }),
      )
      prior.changes = step.changes
      for (const change of prior.changes) {
        const patch = legacy.get(change.id)
        if (patch) (change as PersistedChange).patch = patch
      }
    }
    existing.steps = existing.steps.filter((step) => step.changes.length > 0)
  }
  return order
    .map((id) => prompts.get(id)!)
    .flatMap((prompt) => {
      const steps = prompt.steps.filter((step) => step.changes.length > 0)
      return steps.length > 0 ? [{ ...prompt, steps }] : []
    })
}
