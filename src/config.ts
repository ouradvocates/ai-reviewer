import { getInput, getMultilineInput } from "@actions/core";

export class Config {
  public githubToken: string;
  public llmApiKey: string;
  public llmModel: string;
  public jiraHost: string;
  public jiraUsername: string; 
  public jiraApiToken: string;
  public jiraProjects: string[];
  public jiraDefaultProject: string;
  public styleGuideRules?: string;

  constructor() {
    // Required GitHub token
    this.githubToken = getInput("github-token") || process.env.GITHUB_TOKEN || "";
    if (!this.githubToken) {
      throw new Error("GITHUB_TOKEN is not set");
    }

    // Required LLM settings
    this.llmApiKey = getInput("llm-api-key") || process.env.LLM_API_KEY || "";
    if (!this.llmApiKey) {
      throw new Error("LLM_API_KEY is not set");
    }

    this.llmModel = getInput("llm-model") || process.env.LLM_MODEL || "";
    if (!this.llmModel) {
      throw new Error("LLM_MODEL is not set");
    }

    // JIRA settings
    this.jiraHost = getInput("jira-host") || process.env.JIRA_HOST || "";
    this.jiraUsername = getInput("jira-username") || process.env.JIRA_USERNAME || "";
    this.jiraApiToken = getInput("jira-api-token") || process.env.JIRA_API_TOKEN || "";
    this.jiraProjects = (getInput("jira-projects") || process.env.JIRA_PROJECTS || "").split(",").map(p => p.trim());
    this.jiraDefaultProject = getInput("jira-default-project") || process.env.JIRA_DEFAULT_PROJECT || "";

    // Optional style guide rules
    if (!process.env.DEBUG) {
      this.loadInputs();
    } else {
      console.log("[debug] loading extra inputs from .env");
      this.styleGuideRules = process.env.STYLE_GUIDE_RULES;
    }
  }

  public loadInputs() {
    if (process.env.DEBUG) {
      console.log("[debug] skip loading inputs");
      return;
    }

    // Custom style guide rules
    const styleGuideRules = getMultilineInput('style_guide_rules');
    if (styleGuideRules.length && styleGuideRules[0].trim().length) {
      this.styleGuideRules = styleGuideRules.join("\n");
    }
  }
}

const config = new Config();

export default config;
