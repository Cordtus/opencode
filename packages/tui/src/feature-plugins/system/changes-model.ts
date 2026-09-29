import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { canonicalToolName, finiteNumber, toolDisplayMetadata } from "../../util/tool-display"

export type SessionChange = {
  id: string
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  messageID: string
  toolID: string
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

function countPatch(patch: string) {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  return { additions, deletions }
}

function diffStatus(patch: string, fallback: SessionChange["status"]): SessionChange["status"] {
  if (patch.includes("deleted file mode") || patch.startsWith("+++ /dev/null")) return "deleted"
  if (patch.includes("new file mode") || patch.startsWith("--- /dev/null")) return "added"
  return fallback
}

type PatchFile = {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: SessionChange["status"]
}

function parsePatchFiles(value: unknown): PatchFile[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = record(item)
    if (!file) return []
    const path = stringValue(file.file) ?? stringValue(file.relativePath)
    if (!path) return []
    const status = stringValue(file.status)
    return [
      {
        file: path,
        patch: stringValue(file.patch),
        additions: finiteNumber(file.additions) ?? 0,
        deletions: finiteNumber(file.deletions) ?? 0,
        status: status === "added" || status === "deleted" || status === "modified" ? status : undefined,
      },
    ]
  })
}

/** A change is a file-producing tool call: edit/write/patch. Patch text comes from metadata. */
function changesFromTool(part: SessionMessageAssistantTool, messageID: string): SessionChange[] {
  if (part.state.status === "streaming") return []
  const input = part.state.input
  const metadata = toolDisplayMetadata(part.state)
  const toolID = part.id

  const files = parsePatchFiles(metadata.files)
  if (files.length) {
    return files.map((file, index) => ({
      id: `${toolID}:${index}`,
      file: file.file,
      patch: file.patch,
      additions: file.patch ? countPatch(file.patch).additions : file.additions,
      deletions: file.patch ? countPatch(file.patch).deletions : file.deletions,
      status: file.status ?? (file.patch ? diffStatus(file.patch, "modified") : "modified"),
      messageID,
      toolID,
    }))
  }

  const diff = stringValue(metadata.diff)
  if (diff !== undefined) {
    const file = stringValue(input.path) ?? stringValue(input.filePath) ?? "(unknown)"
    return [
      {
        id: `${toolID}:0`,
        file,
        patch: diff,
        ...countPatch(diff),
        status: diffStatus(diff, "modified"),
        messageID,
        toolID,
      },
    ]
  }

  if (canonicalToolName(part.name) === "write") {
    const file = stringValue(input.path) ?? stringValue(input.filePath)
    if (file) return [{ id: `${toolID}:0`, file, additions: 0, deletions: 0, status: "modified", messageID, toolID }]
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
