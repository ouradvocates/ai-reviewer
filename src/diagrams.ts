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

CRITICAL Mermaid Syntax Rules:
- NEVER use @ symbols ANYWHERE in diagrams (causes parsing errors)
- This includes: edge labels, node IDs, node text, file paths, subgraph names
- Common @ symbol sources to avoid:
  - File paths: src/@types/index.ts → use src/types/index.ts
  - NPM scoped packages: @angular/core → use angular-core
  - Decorators: @Component → use Component
  - Email addresses: user@domain.com → use user-domain-com
  - GitHub usernames: @username → use username
- Keep edge labels short and simple (use "Injectable" not "@Injectable")
- Use alphanumeric characters, spaces, hyphens, and underscores only
- Avoid special characters like @, #, $, %, etc. in ALL diagram elements
- Use underscores or camelCase for node IDs
- Always test syntax mentally before outputting
- Examples of CORRECT syntax:
  - A -->|connects to| B
  - A -.->|implements| B
  - FileService -->|uses| ConfigModule
  - angular-core -->|provides| HttpClient
- Examples of INCORRECT syntax:
  - A -->|@Component| B (@ symbol causes errors)
  - A -->|#method| B (# symbol causes errors)
  - @types/node -->|exports| TypeDefinitions (@ in node ID causes errors)
  - FileService -->|uses| @angular/core (@ in node ID causes errors)

CRITICAL Entity-Relationship Diagram Rules:
- Each entity can only be defined ONCE in the diagram
- NEVER define the same entity multiple times with different content
- To show example data, use comments in attribute definitions or create separate example entities
- Entity attributes must follow the format: datatype attribute_name constraints
- CORRECT ER syntax: Define entity once with examples in comments
- INCORRECT ER syntax: Defining the same entity multiple times with different content

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

  // Validate and sanitize Mermaid syntax before returning
  if (result.shouldGenerate && result.diagram) {
    // First try to auto-sanitize common @ symbol patterns
    const originalDiagram = result.diagram;
    result.diagram = sanitizeMermaidText(result.diagram);
    
    const validationErrors = validateMermaidSyntax(result.diagram);
    if (validationErrors.length > 0) {
      console.warn('Mermaid syntax validation failed:', validationErrors);
      console.warn('Original diagram:', originalDiagram);
      console.warn('Sanitized diagram:', result.diagram);
      // Return a safe fallback
      return {
        shouldGenerate: false,
        type: "none"
      };
    }
  }

  return result;
}

// Validate common Mermaid syntax issues
function validateMermaidSyntax(diagram: string): string[] {
  const errors: string[] = [];
  
  // Check for @ symbols anywhere in the diagram (comprehensive check)
  if (diagram.includes('@')) {
    const atSymbolContexts: string[] = [];
    
    // Check for @ symbols in edge labels
    if (diagram.match(/-->\s*\|[^|]*@[^|]*\|/) || diagram.match(/\.->\s*\|[^|]*@[^|]*\|/)) {
      atSymbolContexts.push("edge labels");
    }
    
    // Check for @ symbols in node IDs (start of line or after whitespace)
    if (diagram.match(/^\s*@\w+/) || diagram.match(/\s@\w+/)) {
      atSymbolContexts.push("node IDs");
    }
    
    // Check for @ symbols in node text (inside square brackets, quotes, or parentheses)
    if (diagram.match(/\[[^\]]*@[^\]]*\]/) || diagram.match(/"[^"]*@[^"]*"/) || diagram.match(/\([^)]*@[^)]*\)/)) {
      atSymbolContexts.push("node text/labels");
    }
    
    // Check for @ symbols in subgraph names
    if (diagram.match(/subgraph\s+[^{\n]*@[^{\n]*/)) {
      atSymbolContexts.push("subgraph names");
    }
    
    // Check for @ symbols in file paths or module names
    if (diagram.match(/@[\w-]+\/\w+/) || diagram.match(/src\/@/) || diagram.match(/node_modules\/@/)) {
      atSymbolContexts.push("file paths or module names");
    }
    
    if (atSymbolContexts.length > 0) {
      errors.push(`Found @ symbols in ${atSymbolContexts.join(', ')}, which cause parsing errors. Replace with safe alternatives (e.g., @angular/core → angular-core, @types → types)`);
    } else {
      // Generic @ symbol found but context unclear
      errors.push("Found @ symbols in diagram, which cause parsing errors. Remove or replace with safe alternatives");
    }
  }
  
  // Check for other problematic characters in edge labels
  const problematicChars = ['#', '$', '%', '^', '&', '*'];
  for (const char of problematicChars) {
    if (diagram.includes(`|${char}`) || diagram.includes(`${char}|`)) {
      errors.push(`Found problematic character '${char}' in edge labels`);
    }
  }
  
  // Check for overly long edge labels
  const edgeLabelMatches = diagram.match(/\|([^|]+)\|/g);
  if (edgeLabelMatches) {
    for (const match of edgeLabelMatches) {
      const label = match.slice(1, -1); // Remove | characters
      if (label.length > 50) {
        errors.push(`Edge label too long (${label.length} chars): "${label.substring(0, 30)}..."`);
      }
    }
  }
  
  // Check for duplicate entity definitions in ER diagrams
  if (diagram.includes('erDiagram')) {
    const entityMatches = diagram.match(/\s+(\w+)\s*\{/g);
    if (entityMatches) {
      const entityNames: string[] = [];
      const duplicates = new Set<string>();
      
      for (const match of entityMatches) {
        const entityName = match.trim().replace(/\s*\{$/, '');
        if (entityNames.includes(entityName)) {
          duplicates.add(entityName);
        } else {
          entityNames.push(entityName);
        }
      }
      
      if (duplicates.size > 0) {
        errors.push(`Duplicate entity definitions found: ${Array.from(duplicates).join(', ')}. Each entity can only be defined once in ER diagrams.`);
      }
    }
    
    // Check for improper attribute definitions in ER diagrams (strings used as attribute names)
    const stringAttributeMatches = diagram.match(/\s+string\s+"[^"]*"/g);
    if (stringAttributeMatches && stringAttributeMatches.length > 0) {
      errors.push("Found string literals used as attribute names in ER diagram. Use proper attribute format: datatype attribute_name constraints");
    }
  }
  
  return errors;
}

// Helper function to suggest safe alternatives for common @ symbol patterns
export function sanitizeMermaidText(text: string): string {
  return text
    // NPM scoped packages
    .replace(/@([a-zA-Z0-9-_]+)\/([a-zA-Z0-9-_]+)/g, '$1-$2')
    // File paths with @types, @angular, etc.
    .replace(/src\/@([a-zA-Z0-9-_]+)/g, 'src/$1')
    .replace(/node_modules\/@([a-zA-Z0-9-_]+)/g, 'node_modules/$1')
    // Decorators
    .replace(/@([A-Z][a-zA-Z0-9]*)/g, '$1')
    // Email addresses
    .replace(/([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '$1-at-$2')
    // GitHub usernames
    .replace(/@([a-zA-Z0-9-_]+)/g, '$1')
    // Generic @ symbols
    .replace(/@/g, 'at');
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