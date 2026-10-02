import { expect, test } from "bun:test"
import { splitAddedPatch, splitPatchHunks } from "../../src/util/diff"

test("splits a complete new-file patch into independently numbered chunks", () => {
  const patch = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,5 @@
+one
+++value beginning with plus signs
+three
+four
+five`
  const chunks = splitAddedPatch(patch, 2)!
  expect(chunks.map((chunk) => chunk.rows)).toEqual([2, 2, 1])
  expect(chunks.map((chunk) => chunk.patch.match(/@@ -0,0 \+(\d+),(\d+) @@/)?.slice(1))).toEqual([
    ["1", "2"],
    ["3", "2"],
    ["5", "1"],
  ])
  expect(chunks.flatMap((chunk) => chunk.lines)).toEqual([
    "+one",
    "+++value beginning with plus signs",
    "+three",
    "+four",
    "+five",
  ])
  expect(chunks.every((chunk) => chunk.patch.startsWith("diff --git a/new.txt b/new.txt"))).toBe(true)
})

test("retains a missing-final-newline marker only on the last chunk", () => {
  const patch = `--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n\\ No newline at end of file\n`
  const chunks = splitAddedPatch(patch, 2)!
  expect(chunks).toHaveLength(2)
  expect(chunks[0].patch).not.toContain("No newline")
  expect(chunks[1].patch).toContain("+three\n\\ No newline at end of file")
})

test("does not split partial or mixed patches", () => {
  expect(splitAddedPatch("@@ -1 +1 @@\n-before\n+after", 2)).toBeUndefined()
  expect(splitAddedPatch("@@ -0,0 +1,3 @@\n+one\n+two", 2)).toBeUndefined()
  expect(splitAddedPatch("@@ -0,0 +1,2 @@\n+one\n two", 2)).toBeUndefined()
})

// A multi-file patch reaching a single hunk slice carries the next file's `diff --git`
// header as a non-diff line. Counting rows must not stall on it.
test("counts hunk rows when a multi-file patch crosses a hunk boundary", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old a",
    "+new a",
    " context",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1,2 +1,2 @@",
    "-old b",
    "+new b",
    " context",
  ].join("\n")
  const hunks = splitPatchHunks(patch)
  expect(hunks).toHaveLength(2)
  // The foreign header lines count as context, but the loop always advances.
  expect(hunks.map((hunk) => hunk.rows)).toEqual([4, 2])
})
