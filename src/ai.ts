import config from "./config";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { info, warning } from "@actions/core";
import { z } from "zod";

const LLM_MODELS = [
  // Anthropic
  {
    name: "claude-sonnet-4-20250514",
    createAi: createAnthropic,
  },
  {
    name: "claude-3-7-sonnet-20250219",
    createAi: createAnthropic,
  },
  {
    name: "claude-3-5-sonnet-20240620",
    createAi: createAnthropic,
  },
  {
    name: "claude-3-5-sonnet-20241022",
    createAi: createAnthropic,
  },
  {
    name: "claude-sonnet-4-5-20250929",
    createAi: createAnthropic,
  },
  // OpenAI
  {
    name: "gpt-4o-mini",
    createAi: createOpenAI,
  },
  {
    name: "o1",
    createAi: createOpenAI,
  },
  {
    name: "o1-mini",
    createAi: createOpenAI,
  },
  {
    name: "o3-mini",
    createAi: createOpenAI,
  },
  // Google stable models https://ai.google.dev/gemini-api/docs/models/gemini
  {
    name: "gemini-2.0-flash-001",
    createAi: createGoogleGenerativeAI,
  },
  {
    name: "gemini-2.0-flash-lite-preview-02-05",
    createAi: createGoogleGenerativeAI,
  },
  {
    name: "gemini-1.5-flash",
    createAi: createGoogleGenerativeAI,
  },
  {
    name: "gemini-1.5-flash-latest",
    createAi: createGoogleGenerativeAI,
  },
  {
    name: "gemini-1.5-flash-8b",
    createAi: createGoogleGenerativeAI,
  },
  {
    name: "gemini-1.5-pro",
    createAi: createGoogleGenerativeAI,
  },
  // Google experimental models https://ai.google.dev/gemini-api/docs/models/experimental-models
  {
    name: "gemini-2.0-pro-exp-02-05",
    createAi: createGoogleGenerativeAI,
  },
  {
    name: "gemini-2.0-flash-thinking-exp-01-21",
    createAi: createGoogleGenerativeAI,
  },
];

/**
 * Try to unwrap a response that the LLM nested under an extra key.
 *
 * Some provider/SDK combinations (notably @ai-sdk/anthropic tool mode) return
 * the structured object wrapped like `{ "$PARAMETER_NAME": { ...actual } }`.
 * When the outer object has exactly one key whose value is a plain object that
 * contains the keys the schema expects, we unwrap and re-validate it.
 *
 * Returns the validated object on success, or `null` if unwrapping isn't
 * applicable or re-validation fails.
 */
function tryUnwrapAndValidate(
  raw: Record<string, unknown>,
  schema: z.ZodObject<any, any>,
): Record<string, unknown> | null {
  const topKeys = Object.keys(raw);
  if (topKeys.length !== 1) return null;

  const inner = raw[topKeys[0]];
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;

  const result = schema.safeParse(inner);
  if (!result.success) return null;

  warning(
    `LLM response was wrapped under "${topKeys[0]}" — unwrapped automatically`,
  );
  return result.data as Record<string, unknown>;
}

export async function runPrompt({
  prompt,
  systemPrompt,
  schema,
}: {
  prompt: string;
  systemPrompt?: string;
  schema: z.ZodObject<any, any>;
}) {
  const model = LLM_MODELS.find((m) => m.name === config.llmModel);
  if (!model) {
    throw new Error(`Unknown LLM model: ${config.llmModel}`);
  }

  const llm = model.createAi({ apiKey: config.llmApiKey });

  try {
    const { object, usage } = await generateObject({
      model: llm(model.name),
      prompt,
      system: systemPrompt,
      schema,
    });

    if (process.env.DEBUG) {
      info(`usage: \n${JSON.stringify(usage, null, 2)}`);
    }

    return object;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "value" in err &&
      err.value &&
      typeof err.value === "object"
    ) {
      const unwrapped = tryUnwrapAndValidate(
        err.value as Record<string, unknown>,
        schema,
      );
      if (unwrapped) return unwrapped;
    }

    throw err;
  }
}
