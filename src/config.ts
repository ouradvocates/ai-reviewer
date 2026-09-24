import { getInput, getMultilineInput } from "@actions/core";
import { AIProviderType } from "./ai";

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
  public enableDiagramGeneration: boolean;
  public diagramMaxFiles: number;
  public llmProvider: string;
  public githubApiUrl: string;
  public githubServerUrl: string;

  public sapAiCoreClientId: string | undefined;
  public sapAiCoreClientSecret: string | undefined;
  public sapAiCoreTokenUrl: string | undefined;
  public sapAiCoreBaseUrl: string | undefined;
  public sapAiResourceGroup: string | undefined;

  constructor() {
    // Required GitHub token
    this.githubToken = getInput("github-token") || process.env.GITHUB_TOKEN || "";
    if (!this.githubToken) {
      throw new Error("GITHUB_TOKEN is not set");
    }

    this.llmModel = getInput("llm-model") || process.env.LLM_MODEL || getInput("llm_model");
    if (!this.llmModel?.length) {
      throw new Error("LLM_MODEL is not set");
    }

    this.llmProvider = process.env.LLM_PROVIDER || getInput("llm_provider");
    if (!this.llmProvider?.length) {
      this.llmProvider = AIProviderType.AI_SDK;
      console.log(`Using default LLM_PROVIDER '${this.llmProvider}'`);
    }

    this.llmApiKey = getInput("llm-api-key") || process.env.LLM_API_KEY || "";
    const isSapAiSdk = this.llmProvider === AIProviderType.SAP_AI_SDK;
    // SAP AI SDK does not require an API key
    if (!this.llmApiKey && !isSapAiSdk) {
      throw new Error("LLM_API_KEY is not set");
    }

    // SAP AI Core configuration
    this.sapAiCoreClientId = process.env.SAP_AI_CORE_CLIENT_ID;
    this.sapAiCoreClientSecret = process.env.SAP_AI_CORE_CLIENT_SECRET;
    this.sapAiCoreTokenUrl = process.env.SAP_AI_CORE_TOKEN_URL;
    this.sapAiCoreBaseUrl = process.env.SAP_AI_CORE_BASE_URL;
    this.sapAiResourceGroup = process.env.SAP_AI_RESOURCE_GROUP;
    if (
      isSapAiSdk &&
      (!this.sapAiCoreClientId ||
        !this.sapAiCoreClientSecret ||
        !this.sapAiCoreTokenUrl ||
        !this.sapAiCoreBaseUrl)
    ) {
      throw new Error(
        "SAP AI Core configuration is not set. Please set SAP_AI_CORE_CLIENT_ID, SAP_AI_CORE_CLIENT_SECRET, SAP_AI_CORE_TOKEN_URL, and SAP_AI_CORE_BASE_URL."
      );
    }

    // GitHub Enterprise Server support
    this.githubApiUrl =
      process.env.GITHUB_API_URL || getInput('github_api_url') || 'https://api.github.com';
    this.githubServerUrl =
      process.env.GITHUB_SERVER_URL || getInput('github_server_url') || 'https://github.com';

    // JIRA settings
    this.jiraHost = getInput("jira-host") || process.env.JIRA_HOST || "";
    this.jiraUsername = getInput("jira-username") || process.env.JIRA_USERNAME || "";
    this.jiraApiToken = getInput("jira-api-token") || process.env.JIRA_API_TOKEN || "";
    this.jiraProjects = (getInput("jira-projects") || process.env.JIRA_PROJECTS || "").split(",").map(p => p.trim());
    this.jiraDefaultProject = getInput("jira-default-project") || process.env.JIRA_DEFAULT_PROJECT || "";

    // Auto-transition tickets to "Shipped" when PR is merged (default: enabled)
    const autoTransitionInput = getInput("auto-transition-tickets-to-shipped") || process.env.AUTO_TRANSITION_TICKETS_TO_SHIPPED;
    this.autoTransitionTicketsToShipped = autoTransitionInput?.toLowerCase() !== "false";

    // Diagram generation settings (default: enabled)
    const enableDiagramInput = getInput("enable-diagram-generation") || process.env.ENABLE_DIAGRAM_GENERATION;
    this.enableDiagramGeneration = enableDiagramInput?.toLowerCase() !== "false";

    // Maximum number of files to analyze for diagrams (default: 10)
    const diagramMaxFilesInput = getInput("diagram-max-files") || process.env.DIAGRAM_MAX_FILES;
    this.diagramMaxFiles = diagramMaxFilesInput ? parseInt(diagramMaxFilesInput, 10) : 10;

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
    try {
      const styleGuideRules = getMultilineInput("style_guide_rules") || [];
      if (
        Array.isArray(styleGuideRules) &&
        styleGuideRules.length &&
        styleGuideRules[0].trim().length
      ) {
        this.styleGuideRules = styleGuideRules.join("\n");
      }
    } catch (e) {
      console.error("Error loading style guide rules:", e);
    }

    // Load additional inputs for description overwrite disable lists
    const disableReposInput = getMultilineInput('disable_description_overwrite_repos') || [];
    if (disableReposInput.length && disableReposInput[0].trim().length) {
      this.disableDescriptionOverwriteRepos = [...new Set([...this.disableDescriptionOverwriteRepos, ...disableReposInput.flatMap(line => line.split(',')).map(r => r.trim().toLowerCase()).filter(r => r.length > 0)])];
    }

    const disableUsersInput = getMultilineInput('disable_description_overwrite_users') || [];
    if (disableUsersInput.length && disableUsersInput[0].trim().length) {
      this.disableDescriptionOverwriteUsers = [...new Set([...this.disableDescriptionOverwriteUsers, ...disableUsersInput.flatMap(line => line.split(',')).map(u => u.trim().toLowerCase()).filter(u => u.length > 0)])];
    }
  }
}

// For testing, we'll modify how the config instance is created
// This prevents the automatic loading when the module is imported
let configInstance: Config | null = null;

// If not in test environment, create and configure the instance
if (process.env.NODE_ENV !== "test") {
  configInstance = new Config();
}

// Export the instance or a function to create one for tests
export default process.env.NODE_ENV === "test"
  ? {
      // Default values for tests
      githubToken: "mock-token",
      llmApiKey: "mock-api-key",
      llmModel: "mock-model",
      llmProvider: "mock-provider",
      styleGuideRules: "",
      sapAiCoreClientId: "mock-client-id",
      sapAiCoreClientSecret: "mock-client-secret",
      sapAiCoreTokenUrl: "mock-token-url",
      sapAiCoreBaseUrl: "mock-base-url",
      sapAiResourceGroup: "default",
      githubApiUrl: "https://api.github.com",
      githubServerUrl: "https://github.com",
      jiraHost: "", jiraUsername: "", jiraApiToken: "", jiraProjects: [], jiraDefaultProject: "",
      disableDescriptionOverwriteRepos: [], disableDescriptionOverwriteUsers: [],
      autoTransitionTicketsToShipped: true, enableDiagramGeneration: true, diagramMaxFiles: 10,
      loadInputs: () => {},
    }
  : configInstance!;
