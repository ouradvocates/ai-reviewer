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

async function requireStructuredOutput(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const next = withRequiredParameters(init);
  const response = await fetch(input, next);
  if (response.ok || typeof next?.body !== "string") return response;

  const body = JSON.parse(next.body);
  if (!("temperature" in body)) return response;

  const errorText = await response.clone().text();
  if (!rejectsTemperature(response.status, errorText)) return response;

  const { temperature: _temperature, ...withoutTemperature } = body;
  return fetch(input, {
    ...next,
    body: JSON.stringify(withoutTemperature),
  });
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
