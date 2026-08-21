import type { MessageWithParts } from "@zmzai/agent-framework";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function outputError(message: string): { value: null; error: string } { return { value: null, error: message }; }

export function isSupportedOutputSchema(value: unknown): value is JsonObject {
  if (!isObject(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 16 * 1024) return false;
  return schemaDepth(value) <= 6;
}

function schemaDepth(value: unknown, depth = 0): number {
  if (!isObject(value) && !Array.isArray(value)) return depth;
  return Math.max(depth, ...Object.values(value).map((child) => schemaDepth(child, depth + 1)));
}

function validate(value: unknown, schema: JsonObject, path = "$", depth = 0): string | null {
  if (depth > 8) return `${path} 超过支持的嵌套深度`;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return `${path} 不在 enum 中`;
  const type = schema.type;
  if (!type) return null;
  if (type === "string") {
    if (typeof value !== "string") return `${path} 必须是 string`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} 长度不足`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} 长度超限`;
    return null;
  }
  if (type === "number" || type === "integer") return typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value)) ? `${path} 必须是 ${type}` : null;
  if (type === "boolean") return typeof value !== "boolean" ? `${path} 必须是 boolean` : null;
  if (type === "array") {
    if (!Array.isArray(value)) return `${path} 必须是 array`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} 项目过多`;
    return isObject(schema.items) ? value.map((item, index) => validate(item, schema.items as JsonObject, `${path}[${index}]`, depth + 1)).find(Boolean) ?? null : null;
  }
  if (type === "object") {
    if (!isObject(value)) return `${path} 必须是 object`;
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
    for (const key of required) if (!(key in value)) return `${path}.${key} 是必填字段`;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return `${path} 包含未声明字段`;
    for (const [key, child] of Object.entries(properties)) if (key in value && isObject(child)) {
      const error = validate(value[key], child, `${path}.${key}`, depth + 1);
      if (error) return error;
    }
    return null;
  }
  return `${path} 使用了未支持的 schema type`;
}

export function finalAssistantText(messages: MessageWithParts[]): string | null {
  for (const message of [...messages].reverse()) {
    if (message.info.role !== "assistant") continue;
    const text = message.parts.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n").trim();
    if (text) return text;
  }
  return null;
}

export function extractStructuredOutput(text: string | null, schema: unknown): { value: unknown | null; error: string | null } {
  if (!schema) return { value: null, error: null };
  if (!isSupportedOutputSchema(schema)) return outputError("output_schema 不属于支持的 JSON Schema 子集");
  const match = text?.match(/```json\s*([\s\S]*?)```\s*$/i);
  if (!match?.[1]) return outputError("最终回复没有以 json 代码块提供结构化输出");
  if (Buffer.byteLength(match[1], "utf8") > 64 * 1024) return outputError("结构化输出超过 64 KiB 限制");
  try {
    const value: unknown = JSON.parse(match[1]);
    const error = validate(value, schema);
    return error ? outputError(error) : { value, error: null };
  } catch { return outputError("结构化输出不是有效 JSON"); }
}
