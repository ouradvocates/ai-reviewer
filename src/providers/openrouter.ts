import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { info } from "@actions/core";
import type { AIProvider, InferenceConfig } from "../ai";
import config from "../config";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// OpenAI strict structured outputs require every property to be listed in
// `required`, and they reject JSON Schema defaults. Zod `.default()` omits
// those keys, which GPT-6.1 Sol refuses.
export function strictJsonSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;

  const node: JsonRecord = { ...schema };
  delete node.$schema;
  delete node.default;

  if (isRecord(node.properties)) {
    const properties: JsonRecord = {};
    for (const [key, value] of Object.entries(node.properties)) {
      properties[key] = strictJsonSchema(value);
    }
    node.properties = properties;
    node.required = Object.keys(properties);
    node.additionalProperties = false;
  }

  if (node.items !== undefined) {
    node.items = Array.isArray(node.items)
      ? node.items.map(strictJsonSchema)
      : strictJsonSchema(node.items);
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(node[key])) {
      node[key] = (node[key] as unknown[]).map(strictJsonSchema);
    }
  }

  for (const key of ["$defs", "definitions"] as const) {
    if (!isRecord(node[key])) continue;
    const defs: JsonRecord = {};
    for (const [name, value] of Object.entries(node[key])) {
      defs[name] = strictJsonSchema(value);
    }
    node[key] = defs;
  }

  return node;
}

// Frontier models on OpenRouter are expected to honor JSON schema output.
// require_parameters keeps the request on endpoints that actually support it.
function withRequiredParameters(init?: RequestInit): RequestInit | undefined {
  if (typeof init?.body !== "string") return init;
  const body = JSON.parse(init.body);
  const schema = body?.response_format?.json_schema?.schema;
  if (schema) {
    body.response_format.json_schema.schema = strictJsonSchema(schema);
  }
  return {
    ...init,
    body: JSON.stringify({
      ...body,
      provider: { ...body.provider, require_parameters: true },
    }),
  };
}

// GPT-6 Sol and similar reasoning models reject temperature. The AI SDK always
// sends one, so drop it and retry when OpenRouter says the parameters are unsupported.
function rejectsTemperature(status: number, body: string): boolean {
  if (status !== 400 && status !== 404) return false;
  return /temperature/i.test(body) || /requested parameters/i.test(body);
}

function contentToString(content: unknown): string | null | undefined {
  if (content == null || typeof content === "string") return content as string | null | undefined;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        if (part.type === "reasoning" || part.type === "thinking") return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .join("");
  }
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return undefined;
}

function httpStatus(code: unknown): number {
  return typeof code === "number" && code >= 400 && code < 600 ? code : 400;
}

// The bundled AI SDK accepts only a narrow chat-completion shape. OpenRouter
// omits choices[].index, returns content as an array of parts, and sometimes
// reports a provider failure as HTTP 200. Those all become "Invalid JSON response".
export function normalizeChatCompletionBody(payload: unknown): {
  body: unknown;
  status?: number;
} {
  if (!isRecord(payload)) return { body: payload };

  if (!Array.isArray(payload.choices)) {
    if (isRecord(payload.error) && typeof payload.error.message === "string") {
      return { body: payload, status: httpStatus(payload.error.code) };
    }
    return { body: payload };
  }

  const choices = payload.choices.map((choice, position) => {
    if (!isRecord(choice)) return choice;
    const next: JsonRecord = { ...choice, index: typeof choice.index === "number" ? choice.index : position };
    if (!isRecord(next.message)) return next;

    const message: JsonRecord = { ...next.message };
    const content = contentToString(message.content);
    if (content !== undefined) message.content = content;
    if (message.role != null && message.role !== "assistant") delete message.role;
    if (Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls.filter(
        (call) =>
          isRecord(call) &&
          call.type === "function" &&
          isRecord(call.function) &&
          typeof call.function.name === "string" &&
          typeof call.function.arguments === "string",
      );
      if (calls.length === message.tool_calls.length) message.tool_calls = calls;
      else delete message.tool_calls;
    }
    next.message = message;

    if (next.logprobs != null && !(isRecord(next.logprobs) && Array.isArray(next.logprobs.content))) {
      delete next.logprobs;
    }
    return next;
  });

  const body: JsonRecord = { ...payload, choices };
  if (typeof body.created === "string" && body.created.trim() !== "" && Number.isFinite(Number(body.created))) {
    body.created = Number(body.created);
  } else if (body.created != null && typeof body.created !== "number") {
    delete body.created;
  }

  const failed = choices.find(
    (choice) =>
      isRecord(choice) &&
      isRecord(choice.error) &&
      typeof choice.error.message === "string" &&
      (choice.message == null ||
        !isRecord(choice.message) ||
        choice.message.content == null ||
        choice.message.content === ""),
  );
  if (isRecord(failed) && isRecord(failed.error)) {
    return {
      body: { error: { message: failed.error.message, code: failed.error.code } },
      status: httpStatus(failed.error.code),
    };
  }

  return { body };
}

async function adaptChatResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const text = await response.text();
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const normalized = normalizeChatCompletionBody(payload);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(normalized.body), {
    status: normalized.status ?? response.status,
    statusText: response.statusText,
    headers,
  });
}

async function requireStructuredOutput(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const next = withRequiredParameters(init);
  let response = await fetch(input, next);
  if (!response.ok && typeof next?.body === "string") {
    const body = JSON.parse(next.body);
    if ("temperature" in body) {
      const errorText = await response.clone().text();
      if (rejectsTemperature(response.status, errorText)) {
        const { temperature: _temperature, ...withoutTemperature } = body;
        response = await fetch(input, {
          ...next,
          body: JSON.stringify(withoutTemperature),
        });
      }
    }
  }
  return adaptChatResponse(response);
}

// OpenRouter speaks the OpenAI API, so the existing structured-output adapter
// can call it with a different base URL and an arbitrary model id.
export function createOpenRouter({ apiKey }: { apiKey?: string }) {
  return createOpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    compatibility: "compatible",
    name: "openrouter",
    headers: {
      "HTTP-Referer": "https://github.com/presubmit/ai-reviewer",
      "X-Title": "Presubmit AI Reviewer",
    },
    fetch: requireStructuredOutput,
  });
}

export class OpenRouterProvider implements AIProvider {
  constructor(private readonly modelName: string) {}

  async runInference({
    prompt,
    temperature,
    system,
    schema,
  }: InferenceConfig): Promise<any> {
    const llm = createOpenRouter({ apiKey: config.llmApiKey });
    const { object, usage } = await generateObject({
      model: llm(this.modelName, { structuredOutputs: true }),
      mode: "json",
      prompt,
      temperature: temperature || 0,
      system,
      schema,
    });

    if (process.env.DEBUG) {
      info(`usage: \n${JSON.stringify(usage, null, 2)}`);
    }

    return object;
  }
}
