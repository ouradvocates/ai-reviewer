import { runPrompt } from "./ai";
import { z } from "zod";
import { File, formatFileDiff } from "./diff";
import { PullRequestSummary } from "./prompts";

export type DiagramType = 
  | "flowchart" 
  | "sequence" 
  | "class" 
  | "state" 
  | "entity-relationship" 
  | "gitgraph" 
  | "architecture"
  | "none";

export interface DiagramGenerationResult {
  shouldGenerate: boolean;
  type: DiagramType;
  diagram?: string;
  title?: string;
  description?: string;
}

interface DiagramGenerationPrompt {
  summary: PullRequestSummary;
  files: File[];
  commitMessages: string[];
}

export async function generateDiagram(
  prompt: DiagramGenerationPrompt
): Promise<DiagramGenerationResult> {
  const systemPrompt = `You are an expert at creating technical diagrams that help visualize code changes in pull requests.

Your task is to analyze PR changes and determine if a diagram would be helpful to understand:
- New features or workflows
- Architectural changes
- Data flow modifications  
- API integrations
- Database schema changes
- Component relationships
- Process flows

Guidelines:
- Only suggest diagrams when they add significant value for understanding the changes
- Choose the most appropriate diagram type for the changes
- Keep diagrams simple and focused on the key changes
- Use clear, descriptive labels
- Avoid diagrams for minor changes like bug fixes, typos, or simple refactoring
- Prefer flowcharts for processes, sequence diagrams for interactions, class diagrams for OOP changes

Diagram Types Available:
- flowchart: For processes, workflows, decision trees
- sequence: For API calls, user interactions, system communications  
- class: For OOP relationships, data models
- state: For state machines, status transitions
- entity-relationship: For database schema changes
- gitgraph: For branch/merge visualizations (rarely needed)
- architecture: For system architecture changes
- none: When no diagram would be helpful

Diagram Generation Guidelines:
- When asked to create a diagram, first determine which format is most suitable:
  - Mermaid for flowcharts and simple diagrams
  - PlantUML for UML and architecture diagrams
  - GraphViz for graphs/trees/networks
  - D2 for modern system architectures
- Then create and embed the diagram using markdown code blocks with the appropriate language identifier:
  - \`\`\`mermaid\n\n<diagram>\n\n\`\`\`
  - \`\`\`plantuml\n\n<diagram>\n\n\`\`\`
  - \`\`\`dot\n\n<diagram>\n\n\`\`\`
  - \`\`\`d2\n\n<diagram>\n\n\`\`\`


IMPORTANT: Generate valid diagram syntax only. Test your syntax mentally before outputting.`;

  const userPrompt = `Analyze this PR and determine if a diagram would be helpful:

<PR Summary>
Title: ${prompt.summary.title}
Description: ${prompt.summary.description}
Type: ${prompt.summary.type.join(", ")}
</PR Summary>

<File Changes>
${prompt.summary.files.map(f => `- ${f.filename}: ${f.title} - ${f.summary}`).join("\n")}
</File Changes>

<Commit Messages>
${prompt.commitMessages.join("\n")}
</Commit Messages>

<File Diffs>
${prompt.files.slice(0, 5).map(file => formatFileDiff(file)).join("\n\n")}
</File Diffs>

Should a diagram be generated? If yes, what type and content?`;

  const schema = z.object({
    shouldGenerate: z.boolean().describe("Whether a diagram would be helpful for understanding these changes"),
    type: z.enum(["flowchart", "sequence", "class", "state", "entity-relationship", "gitgraph", "architecture", "none"]).describe("The most appropriate diagram type for these changes"),
    diagram: z.string().optional().describe("Valid Mermaid diagram syntax (only if shouldGenerate is true)"),
    title: z.string().optional().describe("Brief title for the diagram (only if shouldGenerate is true)"),
    description: z.string().optional().describe("One sentence description of what the diagram shows (only if shouldGenerate is true)")
  });

  const result = await runPrompt({
    prompt: userPrompt,
    systemPrompt,
    schema,
  }) as DiagramGenerationResult;

  // Validate that we have required fields when shouldGenerate is true
  if (result.shouldGenerate && (!result.diagram || !result.title)) {
    return {
      shouldGenerate: false,
      type: "none"
    };
  }

  return result;
}

export function formatDiagramForMarkdown(result: DiagramGenerationResult): string {
  if (!result.shouldGenerate || !result.diagram || !result.title) {
    return "";
  }

  let markdown = `## ${result.title}\n\n`;
  
  if (result.description) {
    markdown += `${result.description}\n\n`;
  }

  markdown += "```mermaid\n";
  markdown += result.diagram;
  markdown += "\n```\n\n";

  return markdown;
}

// Helper function to detect common patterns that might benefit from diagrams
export function analyzeForDiagramOpportunities(summary: PullRequestSummary, files: File[]): {
  hasApiChanges: boolean;
  hasWorkflowChanges: boolean;
  hasSchemaChanges: boolean;
  hasArchitecturalChanges: boolean;
  hasStateChanges: boolean;
} {
  const allText = `${summary.title} ${summary.description} ${files.map(f => f.filename).join(" ")}`.toLowerCase();
  
  return {
    hasApiChanges: /api|endpoint|route|controller|service/.test(allText),
    hasWorkflowChanges: /workflow|process|step|flow|pipeline/.test(allText),
    hasSchemaChanges: /schema|migration|database|table|model/.test(allText),
    hasArchitecturalChanges: /component|module|service|architecture|integration/.test(allText),
    hasStateChanges: /state|status|transition|stage/.test(allText)
  };
} 