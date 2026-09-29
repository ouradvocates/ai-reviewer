import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { runPrompt } from "../ai";
import config from "../config";
import {
  createOpenRouter,
  OPENROUTER_BASE_URL,
  OpenRouterProvider,
  strictJsonSchema,
} from "../providers/openrouter";

jest.mock("ai", () => ({
  generateObject: jest.fn().mockResolvedValue({ object: { ok: true }, usage: {} }),
}));

jest.mock("@ai-sdk/openai", () => ({
  createOpenAI: jest.fn(() => jest.fn()),
}));

jest.mock("../providers/ai-sdk", () => ({
  AISDKProvider: jest.fn().mockImplementation(() => ({
    runInference: jest.fn().mockResolvedValue({ ok: true }),
  })),
}));

jest.mock("../providers/sapaicore", () => ({
  SAPAIProvider: jest.fn(),
}));

jest.mock("../config", () => ({
  __esModule: true,
  default: {
    llmProvider: "openrouter",
    llmModel: "anthropic/claude-sonnet-4.5",
    llmApiKey: "test-key",
  },
}));

const schema = z.object({ ok: z.boolean() });

describe("OpenRouter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.llmProvider = "openrouter";
    config.llmModel = "anthropic/claude-sonnet-4.5";
  });

  test("points the OpenAI-compatible client at OpenRouter", async () => {
    createOpenRouter({ apiKey: "sk-or-test" });

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-or-test",
      baseURL: OPENROUTER_BASE_URL,
      compatibility: "compatible",
      name: "openrouter",
      headers: {
        "HTTP-Referer": "https://github.com/presubmit/ai-reviewer",
        "X-Title": "Presubmit AI Reviewer",
      },
      fetch: expect.any(Function),
    });

    const fetchImpl = (createOpenAI as jest.Mock).mock.calls[0][0].fetch as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock;
    try {
      await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "anthropic/claude-opus-5.5" }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const forwarded = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(forwarded.provider).toEqual({ require_parameters: true });
  });

  test("requires every JSON schema property for strict models", async () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string", default: "" },
        files: {
          type: "array",
          default: [],
          items: {
            type: "object",
            properties: { filename: { type: "string" } },
            required: ["filename"],
          },
        },
      },
      required: ["title"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    };
    const expected = {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { filename: { type: "string" } },
            required: ["filename"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "description", "files"],
      additionalProperties: false,
    };

    expect(strictJsonSchema(schema)).toEqual(expected);

    createOpenRouter({ apiKey: "sk-or-test" });
    const fetchImpl = (createOpenAI as jest.Mock).mock.calls[0][0].fetch as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock;
    try {
      await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "openai/gpt-6.1-sol",
          response_format: { type: "json_schema", json_schema: { name: "response", schema } },
        }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const forwarded = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(forwarded.response_format.json_schema.schema).toEqual(expected);
  });

  test("retries without temperature when the model rejects it", async () => {
    createOpenRouter({ apiKey: "sk-or-test" });
    const fetchImpl = (createOpenAI as jest.Mock).mock.calls[0][0].fetch as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    const originalFetch = globalThis.fetch;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: "No endpoints found that can handle the requested parameters.", code: 404 },
          }),
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock;
    try {
      const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "openai/gpt-6.1-sol",
          temperature: 0,
        }),
      });
      expect(response.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retried = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(retried.temperature).toBeUndefined();
    expect(retried.provider).toEqual({ require_parameters: true });
    expect(retried.model).toBe("openai/gpt-6.1-sol");
  });

  test("accepts any OpenRouter model id", async () => {
    config.llmModel = "google/gemini-2.5-pro";

    await expect(runPrompt({ prompt: "Review", schema })).resolves.toEqual({ ok: true });
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Review", schema }),
    );
  });

  test("requests JSON schema output for every OpenRouter model", async () => {
    const chat = jest.fn(() => ({ modelId: "anthropic/claude-opus-5.5" }));
    (createOpenAI as jest.Mock).mockReturnValue(chat);

    const provider = new OpenRouterProvider("anthropic/claude-opus-5.5");
    await expect(provider.runInference({ prompt: "Review", schema })).resolves.toEqual({ ok: true });

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "json", prompt: "Review", schema }),
    );
    expect(chat).toHaveBeenCalledWith("anthropic/claude-opus-5.5", { structuredOutputs: true });
  });

  test("still rejects models outside the built-in provider catalogs", async () => {
    config.llmProvider = "ai-sdk";
    config.llmModel = "claude-opus-5-5";

    await expect(runPrompt({ prompt: "Review", schema })).rejects.toThrow(
      /Unknown LLM model: claude-opus-5-5/,
    );
  });
});
