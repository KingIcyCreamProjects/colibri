import { describe, expect, it } from "vitest"

import { splitBlocks, splitReasoning } from "./markdown"

describe("splitBlocks", () => {
  it("separates prose from a closed fenced block", () => {
    const blocks = splitBlocks("before\n```js\nconst a = 1\n```\nafter")
    expect(blocks.map((b) => b.t)).toEqual(["md", "code", "md"])
    expect(blocks[1]).toMatchObject({ t: "code", lang: "js", code: "const a = 1" })
  })

  it("renders an open fence as a code block before the closing fence arrives", () => {
    const blocks = splitBlocks("```py\nprint(1)")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ t: "code", lang: "py", code: "print(1)" })
  })

  it("keeps finished-block keys stable as later content grows", () => {
    const a = splitBlocks("```js\nx\n```\ntail")
    const b = splitBlocks("```js\nx\n```\ntail more\n```py\ny")
    expect(a[0].key).toBe(b[0].key) // the first code block does not re-key
  })
})

describe("splitReasoning", () => {
  it("splits GLM's primed stream (reasoning…</think>answer) with no opening tag", () => {
    expect(splitReasoning("weighing options</think>The answer is 42")).toEqual({
      think: "weighing options", answer: "The answer is 42",
    })
  })

  it("returns null until the closing tag streams in", () => {
    expect(splitReasoning("still thinking")).toBeNull()
  })
})
