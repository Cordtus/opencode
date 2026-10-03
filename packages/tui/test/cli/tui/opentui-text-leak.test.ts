import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { CodeRenderable, SyntaxStyle } from "@opentui/core"

// @opentui <=0.5.12 leaked the replaced text-buffer rope on every setText (~1.24MB per 2000-line
// set), the resize memory blow-up. 0.5.13/0.5.14 release it.
test("repeated text updates do not leak memory", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const node = new CodeRenderable(setup.renderer, { content: "", syntaxStyle: SyntaxStyle.create() })
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n")
  const before = process.memoryUsage().rss
  for (let i = 0; i < 300; i++) node.content = `${big}\n${i}`
  const after = process.memoryUsage().rss
  console.log("rss delta MB:", ((after - before) / 1024 / 1024).toFixed(1))
  expect(after - before).toBeLessThan(150 * 1024 * 1024)
  setup.renderer.destroy()
}, 120_000)
