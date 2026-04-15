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
 *
 * Strategy 1 (original): The outer object has exactly one key whose value is a
 * plain object containing the keys the schema expects — unwrap and re-validate.
 *
 * Strategy 2 (partial wrapping): Real schema fields sit at the top level
 * alongside a `$PARAMETER_NAME` key whose value is an XML-like string
 * (`<parameter name="field">value</parameter>`). We extract the missing field
 * from that string and merge it back into the object.
 *
 * Strategy 3 (partial response): The LLM returned some schema fields but
 * omitted others that have defaults. Re-parse with Zod so defaults fill in
 * the gaps (e.g. LLM returns `{ comments }` but omits `review`).
 *
 * Returns the validated object on success, or `null` if unwrapping isn't
 * applicable or re-validation fails.
 */
function tryUnwrapAndValidate(
  raw: Record<string, unknown>,
  schema: z.ZodObject<any, any>,
): Record<string, unknown> | null {
  const topKeys = Object.keys(raw);

  // Strategy 1: single wrapper key containing a full nested object
  if (topKeys.length === 1) {
    const inner = raw[topKeys[0]];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const result = schema.safeParse(inner);
      if (result.success) {
        warning(
          `LLM response was wrapped under "${topKeys[0]}" — unwrapped automatically`,
        );
        return result.data as Record<string, unknown>;
      }
    }
  }

  // Strategy 2: $PARAMETER_NAME coexists with real schema fields
  const wrappedKey = topKeys.find(
    (k) => k.startsWith("$") && typeof raw[k] === "string",
  );
  if (wrappedKey) {
    const schemaKeys = Object.keys(schema.shape);
    const presentKeys = topKeys.filter((k) => k !== wrappedKey && schemaKeys.includes(k));
    if (presentKeys.length > 0) {
      const missingKeys = schemaKeys.filter(
        (k) => !(k in raw) || k === wrappedKey,
      );

      const merged: Record<string, unknown> = {};
      for (const k of presentKeys) merged[k] = raw[k];

      const xmlStr = raw[wrappedKey] as string;

      for (const key of missingKeys) {
        const re = new RegExp(
          `<parameter\\s+name=["']${key}["']>([\\s\\S]*?)</parameter>`,
        );
        const match = xmlStr.match(re);
        if (match) {
          merged[key] = match[1].trim();
        }
      }

      // If we still have exactly one missing required field and couldn't extract
      // it from XML tags, assign the raw string as a last resort.
      const stillMissing = schemaKeys.filter((k) => !(k in merged));
      if (stillMissing.length === 1) {
        merged[stillMissing[0]] = xmlStr;
      }

      const result = schema.safeParse(merged);
      if (result.success) {
        warning(
          `LLM response had partial "${wrappedKey}" wrapping — reconstructed automatically`,
        );
        return result.data as Record<string, unknown>;
      }
    }
  }

  // Strategy 3: partial or empty response — LLM returned some (or no) schema
  // keys. If at least one schema key is present, or the response is completely
  // empty, try to parse so that Zod .default() values fill in the gaps.
  const schemaKeys = Object.keys(schema.shape);
  const matchingKeys = topKeys.filter((k) => schemaKeys.includes(k));
  if (matchingKeys.length > 0 || topKeys.length === 0) {
    const relaxed = schema.partial();
    const partialResult = relaxed.safeParse(raw);
    if (partialResult.success) {
      // Re-validate against the full schema — Zod .default() values will have
      // been applied by .partial() parse, but truly required fields may still
      // be missing. Merge parsed partial data back through the full schema
      // so that defaults on the full schema also apply.
      const fullResult = schema.safeParse(partialResult.data);
      if (fullResult.success) {
        const missingFields = schemaKeys.filter((k) => !topKeys.includes(k));
        warning(
          `LLM response was missing field(s) [${missingFields.join(", ")}] — filled with defaults`,
        );
        return fullResult.data as Record<string, unknown>;
      }
    }
  }

  return null;
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
