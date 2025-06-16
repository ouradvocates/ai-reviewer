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
  public disableDescriptionOverwriteRepos: string[];
  public disableDescriptionOverwriteUsers: string[];
  public autoTransitionTicketsToShipped: boolean;

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

    // Auto-transition tickets to "Shipped" when PR is merged (default: enabled)
    const autoTransitionInput = getInput("auto-transition-tickets-to-shipped") || process.env.AUTO_TRANSITION_TICKETS_TO_SHIPPED;
    this.autoTransitionTicketsToShipped = autoTransitionInput === undefined || autoTransitionInput === "" || 
      autoTransitionInput.toLowerCase() === "true" || autoTransitionInput === "1";

    // Optional: Disable description overwrite for specific repos or users
    this.disableDescriptionOverwriteRepos = (getInput("disable-description-overwrite-repos") || process.env.DISABLE_DESCRIPTION_OVERWRITE_REPOS || "").split(",").map(r => r.trim().toLowerCase()).filter(r => r.length > 0);
    this.disableDescriptionOverwriteUsers = (getInput("disable-description-overwrite-users") || process.env.DISABLE_DESCRIPTION_OVERWRITE_USERS || "").split(",").map(u => u.trim().toLowerCase()).filter(u => u.length > 0);

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

    // Load additional inputs for description overwrite disable lists
    const disableReposInput = getMultilineInput('disable_description_overwrite_repos');
    if (disableReposInput.length && disableReposInput[0].trim().length) {
      this.disableDescriptionOverwriteRepos = [...new Set([...this.disableDescriptionOverwriteRepos, ...disableReposInput.flatMap(line => line.split(',')).map(r => r.trim().toLowerCase()).filter(r => r.length > 0)])];
    }

    const disableUsersInput = getMultilineInput('disable_description_overwrite_users');
    if (disableUsersInput.length && disableUsersInput[0].trim().length) {
      this.disableDescriptionOverwriteUsers = [...new Set([...this.disableDescriptionOverwriteUsers, ...disableUsersInput.flatMap(line => line.split(',')).map(u => u.trim().toLowerCase()).filter(u => u.length > 0)])];
    }
  }
}

const config = new Config();

export default config;
