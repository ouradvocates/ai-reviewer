const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// Load the real TypeScript module with mocked external boundaries. No API calls.
function loadSource(filename, mocks, globals = {}) {
  const source = readFileSync(path.join(__dirname, "../src", filename), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    Error,
    require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id === "zod") return require(id);
      throw new Error(`Unexpected dependency: ${id}`);
    },
    ...globals,
  }, { filename });
  return exports;
}

const pr = { prTitle: "Example", prDescription: "Existing description", commitMessages: [], files: [] };

for (const response of [{}, { filledTemplate: "" }, { filledTemplate: " \n\t" }]) {
  test(`rejects empty template ${JSON.stringify(response)} before adding diagrams`, async () => {
    const { fillPRTemplate } = loadSource("prompts.ts", {
      "./ai": { runPrompt: async ({ schema }) => schema.parse(response) },
      "./diff": {},
      "./config": { default: { enableDiagramGeneration: true } },
      "./diagrams": {
        analyzeForDiagramOpportunities() { assert.fail("Empty output must not generate diagrams"); },
      },
    });
    await assert.rejects(fillPRTemplate(pr, {}), /returned an empty template/);
  });
}

test("keeps a valid generated description", async () => {
  const { fillPRTemplate } = loadSource("prompts.ts", {
    "./ai": { runPrompt: async ({ schema }) => schema.parse({ filledTemplate: "## Summary\nUpdated behavior." }) },
    "./diff": {},
    "./config": { default: { enableDiagramGeneration: false } },
    "./diagrams": {},
  });
  assert.equal(await fillPRTemplate(pr), "## Summary\nUpdated behavior.");
});

test("empty generation preserves the PR body and reaches the review phase", async () => {
  const config = { enableDiagramGeneration: false, githubToken: "test" };
  const { fillPRTemplate } = loadSource("prompts.ts", {
    "./ai": { runPrompt: async ({ schema }) => schema.parse({}) },
    "./diff": {},
    "./config": { default: config },
    "./diagrams": {},
  });
  const reviewReached = new Error("review phase reached");
  let updates = 0;
  const warnings = [];
  const { handlePullRequest } = loadSource("pull_request.ts", {
    "@actions/core": { info() {}, warning: (message) => warnings.push(message) },
    "./config": { default: config },
    "./context": { loadContext: async () => ({
      eventName: "pull_request", repo: { owner: "example", repo: "example" },
      payload: { action: "synchronize", pull_request: { number: 1, title: pr.prTitle, body: pr.prDescription } },
    }) },
    "./octokit": { initOctokit: () => ({ rest: {
      pulls: {
        listCommits: async () => ({ data: [] }),
        listFiles: async () => ({ data: [] }),
        update: async () => { updates++; },
      },
      issues: { listComments: async () => { throw reviewReached; } },
    } }) },
    "./prompts": { fillPRTemplate, runSummaryPrompt: async () => ({ title: "Example", description: "Example" }) },
    "./messages": {}, "./diff": {}, "./comments": {}, "./jira": {},
  });
  await assert.rejects(handlePullRequest(), (error) => error === reviewReached);
  assert.equal(updates, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /empty template/);
});

for (const event of ["pull_request", "pull_request_review_comment"]) {
  test(`reports asynchronous ${event} failures through setFailed`, async () => {
    let failure;
    const reject = async () => { throw new Error("simulated failure"); };
    loadSource("main.ts", {
      "@actions/core": { setFailed: (message) => { failure = message; } },
      "./pull_request": { handlePullRequest: reject },
      "./pull_request_comment": { handlePullRequestComment: reject },
    }, { process: { env: { GITHUB_EVENT_NAME: event } } });
    await new Promise(setImmediate);
    assert.equal(failure, "Failed with error: simulated failure");
  });
}
