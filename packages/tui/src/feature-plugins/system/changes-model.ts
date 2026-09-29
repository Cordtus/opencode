import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
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

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
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
    .map((text) =>
      text
        .split("\n")
        .find((line) => line.trim())
        ?.trim(),
    )
    .find(Boolean)
  if (!first) return `Step ${index}`
  return first.length > 72 ? `${first.slice(0, 71)}…` : first
}

/**
 * V2 removed the todo model and the `todowrite` tool, so there is no plan to attach
 * changes to. The closest durable unit is the logical step = one assistant message
 * (`SessionMessageAssistant`). Each step carries its reasoning and the file changes
 * from the edit/write/patch tool calls it contains.
 */
export function deriveSteps(messages: SessionMessageInfo[]): SessionStep[] {
  const steps: SessionStep[] = []
  let index = 0
  for (const message of messages) {
    if (message.type !== "assistant") continue
    index++
    const changes = message.content.flatMap((part) => (part.type === "tool" ? changesFromTool(part, message.id) : []))
    const running = message.time.completed === undefined
    if (changes.length === 0 && !running) continue
    const reasoning = message.content
      .flatMap((part) => (part.type === "reasoning" ? [part.text] : []))
      .filter(Boolean)
      .join("\n\n")
    steps.push({
      id: message.id,
      label: stepLabel(message, index),
      status: message.error ? "error" : running ? "running" : "done",
      reasoning,
      changes,
    })
  }
  return steps
}
