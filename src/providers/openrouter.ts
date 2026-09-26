import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { info } from "@actions/core";
import type { AIProvider, InferenceConfig } from "../ai";
import config from "../config";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Frontier models on OpenRouter are expected to honor JSON schema output.
// require_parameters keeps the request on endpoints that actually support it.
function requireStructuredOutput(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (typeof init?.body === "string") {
    const body = JSON.parse(init.body);
    init = {
      ...init,
      body: JSON.stringify({
        ...body,
        provider: { ...body.provider, require_parameters: true },
      }),
    };
  }
  return fetch(input, init);
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
