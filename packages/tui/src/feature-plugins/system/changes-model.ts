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
  /** Unified patch. Absent for `write`, whose completed result carries no file metadata. */
  patch?: string
  additions: number
  deletions: number
  /** Absent when the producer did not report one (e.g. `write`). */
  status?: "added" | "deleted" | "modified"
  messageID: string
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
  patch: string
  additions: number
  deletions: number
  status?: SessionChange["status"]
}

/** `metadata.files` is the canonical `FileDiff.Info` list emitted by edit/patch. */
function parsePatchFiles(value: unknown): PatchFile[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = record(item)
    if (!file) return []
    const path = stringValue(file.file)
    const patch = stringValue(file.patch)
    if (!path || patch === undefined) return []
    const status = stringValue(file.status)
    return [
      {
        file: path,
        patch,
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
      patch: file.patch,
      additions: file.additions,
      deletions: file.deletions,
      status: file.status,
      messageID,
    }))
  }

  // `write` returns output/content only; its diff is never persisted on the tool result.
  if (canonicalToolName(part.name) === "write") {
    const file = stringValue(part.state.input.path)
    if (file) return [{ id: `${part.id}:0`, file, additions: 0, deletions: 0, messageID }]
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
 * Steps without changes are kept once seen (a "Step 5" that appeared must not vanish
 * when it completes), so the projection is a growing history rather than a live filter.
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
    const reasoning = message.content
      .flatMap((part) => (part.type === "reasoning" ? [part.text] : []))
      .filter(Boolean)
      .join("\n\n")
    const hasTool = message.content.some((part) => part.type === "tool")
    // Keep only steps that did something: a change, a thought, or a tool call.
    if (changes.length === 0 && !reasoning && !hasTool) continue

    stepIndex++
    ensurePrompt().steps.push({
      id: message.id,
      label: stepLabel(message, stepIndex),
      status: message.error ? "error" : message.time.completed === undefined ? "running" : "done",
      reasoning,
      changes,
    })
  }

  return prompts
}

/**
 * Union-merge a freshly derived history into the accumulated one. Steps and prompts
 * are never removed: once the client message window (last ~20) drops a message, the
 * persisted copy is the only remaining record.
 */
export function mergeHistory(previous: SessionPrompt[] | undefined, next: SessionPrompt[]): SessionPrompt[] {
  if (!previous?.length) return next

  const prompts = new Map(previous.map((prompt) => [prompt.id, prompt]))
  const order = previous.map((prompt) => prompt.id)
  for (const incoming of next) {
    const existing = prompts.get(incoming.id)
    if (!existing) {
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
      prior.changes = step.changes
    }
  }
  return order.map((id) => prompts.get(id)!)
}
