import { getInput } from "@actions/core";

export interface Config {
  githubToken: string;
  llmApiKey: string;
  llmModel: string;
  jiraHost: string;
  jiraUsername: string;
  jiraApiToken: string;
  jiraProjects: string[];
  jiraDefaultProject: string;
}

const config: Config = {
  githubToken: getInput("github-token") || process.env.GITHUB_TOKEN || "",
  llmApiKey: getInput("llm-api-key") || process.env.LLM_API_KEY || "",
  llmModel: getInput("llm-model") || process.env.LLM_MODEL || "",
  jiraHost: getInput("jira-host") || process.env.JIRA_HOST || "",
  jiraUsername: getInput("jira-username") || process.env.JIRA_USERNAME || "",
  jiraApiToken: getInput("jira-api-token") || process.env.JIRA_API_TOKEN || "",
  jiraProjects: (getInput("jira-projects") || process.env.JIRA_PROJECTS || "").split(",").map(p => p.trim()),
  jiraDefaultProject: getInput("jira-default-project") || process.env.JIRA_DEFAULT_PROJECT || "",
};

export default config;
