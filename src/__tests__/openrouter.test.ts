import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { runPrompt } from "../ai";
import config from "../config";
import { createOpenRouter, OPENROUTER_BASE_URL, OpenRouterProvider } from "../providers/openrouter";

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
