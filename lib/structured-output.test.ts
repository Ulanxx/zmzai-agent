import { describe, expect, it } from "vitest";

import { extractStructuredOutput, finalAssistantText, isSupportedOutputSchema } from "@/lib/structured-output";

const schema = { type: "object", required: ["title", "score"], additionalProperties: false, properties: { title: { type: "string", maxLength: 20 }, score: { type: "integer" } } };

describe("structured output", () => {
  it("extracts and validates the final JSON code block", () => {
    expect(extractStructuredOutput("完成。\n```json\n{\"title\":\"结论\",\"score\":3}\n```", schema)).toEqual({ value: { title: "结论", score: 3 }, error: null });
  });

  it("does not treat an invalid final response as a valid structured result", () => {
    expect(extractStructuredOutput("```json\n{\"title\":\"结论\"}\n```", schema)).toMatchObject({ value: null, error: "$.score 是必填字段" });
    expect(extractStructuredOutput("plain text", schema)).toMatchObject({ value: null, error: "最终回复没有以 json 代码块提供结构化输出" });
  });

  it("accepts only bounded schema objects", () => {
    expect(isSupportedOutputSchema(schema)).toBe(true);
    expect(isSupportedOutputSchema([schema])).toBe(false);
  });

  it("uses the latest assistant text rather than reasoning or tool output", () => {
    const text = finalAssistantText([
      { info: { role: "assistant" } as never, parts: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "first" }] as never },
      { info: { role: "assistant" } as never, parts: [{ type: "tool", state: { status: "completed", output: "tool" } }, { type: "text", text: "final" }] as never },
    ]);
    expect(text).toBe("final");
  });
});
