import { context } from "@actions/github";
import { FileDiff } from "./diff";
import { AIComment, PullRequestSummary } from "./prompts";
import { Context } from "@actions/github/lib/context";

export const OVERVIEW_MESSAGE_SIGNATURE =
  "\n<!-- presubmit.ai: overview message -->";

export const COMMENT_SIGNATURE = "\n<!-- presubmit.ai: comment -->";

export const PAYLOAD_TAG_OPEN = "\n<!-- presubmit.ai: payload --";
export const PAYLOAD_TAG_CLOSE = "\n-- presubmit.ai: payload -->";

export function buildLoadingMessage(
  baseCommit: string,
  commits: {
    sha: string;
    commit: {
      message: string;
    };
  }[],
  fileDiffs: FileDiff[]
): string {
  const { owner, repo } = context.repo;

  let message = `⏳ **Analyzing changes in this PR...** ⏳\n\n`;
  message += `_This might take a few minutes, please wait_\n\n`;

  // Group files by operation
  message += `<details>\n<summary>📥 Commits</summary>\n\n`;
  message += `Analyzing changes from base (\`${baseCommit.slice(
    0,
    7
  )}\`) to latest commit (\`${commits[commits.length - 1].sha.slice(
    0,
    7
  )}\`):\n`;

  for (const commit of commits.reverse()) {
    message += `- [${commit.sha.slice(
      0,
      7
    )}](https://github.com/${owner}/${repo}/commit/${commit.sha}): ${
      commit.commit.message
    }\n`;
  }

  message += "\n\n</details>\n\n";

  message += `<details>\n<summary>📁 Files being considered (${fileDiffs.length})</summary>\n\n`;
  for (const diff of fileDiffs) {
    let prefix = "🔄"; // Modified
    if (diff.status === "added") prefix = "➕";
    if (diff.status === "removed") prefix = "➖";
    if (diff.status === "renamed") prefix = "📝";

    let fileText = `${prefix} ${diff.filename}`;
    if (diff.status === "renamed") {
      fileText += ` (from ${diff.previous_filename})`;
    }
    fileText += ` _(${diff.hunks.length} ${
      diff.hunks.length === 1 ? "hunk" : "hunks"
    })_`;
    message += `${fileText}\n`;
  }
  message += "\n</details>\n\n";

  message += OVERVIEW_MESSAGE_SIGNATURE;

  return message;
}

export function buildOverviewMessage(
  summary: PullRequestSummary,
  commits: string[]
): string {
  let message = `### Changes\n\n`;

  // Group files by directory structure and prioritize important changes
  const fileGroups = groupFilesByDirectory(summary.files);
  const sortedGroups = sortGroupsByImportance(fileGroups);

  for (const [directory, files] of sortedGroups) {
    // Add directory header if there are multiple directories or it's not root
    if (sortedGroups.length > 1 || directory !== ".") {
      const dirIcon = getDirectoryIcon(directory);
      message += `#### ${dirIcon} ${directory === "." ? "Root" : directory}\n\n`;
    }

    // Sort files within directory by importance
    const sortedFiles = sortFilesByImportance(files);

    for (const file of sortedFiles) {
      const fileIcon = getFileIcon(file.filename);
      const fileName = getFileDisplayName(file.filename, directory);
      
      // Use title as a prominent heading if it's informative
      if (file.title && file.title.toLowerCase() !== "file changes" && file.title.toLowerCase() !== "changes") {
        message += `**${fileIcon} ${fileName}** — *${file.title}*\n`;
      } else {
        message += `**${fileIcon} ${fileName}**\n`;
      }
      
      message += `${file.summary}\n\n`;
    }

    // Add spacing between directory groups
    if (sortedGroups.length > 1) {
      message += `---\n\n`;
    }
  }

  const payload = {
    commits: commits,
  };

  message += OVERVIEW_MESSAGE_SIGNATURE;
  message += PAYLOAD_TAG_OPEN;
  message += JSON.stringify(payload);
  message += PAYLOAD_TAG_CLOSE;

  return message;
}

// Helper functions for better file organization and display
function groupFilesByDirectory(files: PullRequestSummary['files']): Map<string, PullRequestSummary['files']> {
  const groups = new Map<string, PullRequestSummary['files']>();
  
  for (const file of files) {
    const directory = file.filename.includes('/') 
      ? file.filename.substring(0, file.filename.lastIndexOf('/'))
      : '.';
    
    if (!groups.has(directory)) {
      groups.set(directory, []);
    }
    groups.get(directory)!.push(file);
  }
  
  return groups;
}

function sortGroupsByImportance(groups: Map<string, PullRequestSummary['files']>): [string, PullRequestSummary['files']][] {
  const dirPriority = (dir: string): number => {
    if (dir === '.') return 1; // Root files first
    if (dir.includes('src') || dir.includes('lib')) return 2; // Source code
    if (dir.includes('test') || dir.includes('spec')) return 5; // Tests later
    if (dir.includes('config') || dir.includes('.github')) return 3; // Config
    if (dir.includes('docs') || dir.includes('doc')) return 6; // Docs last
    return 4; // Everything else
  };
  
  return Array.from(groups.entries()).sort((a, b) => dirPriority(a[0]) - dirPriority(b[0]));
}

function sortFilesByImportance(files: PullRequestSummary['files']): PullRequestSummary['files'] {
  const getFilePriority = (filename: string): number => {
    const name = filename.toLowerCase();
    
    // High priority files
    if (name.includes('package.json') || name.includes('requirements.txt') || name.includes('yarn.lock')) return 1;
    if (name.includes('dockerfile') || name.includes('docker-compose')) return 1;
    if (name.includes('readme') || name.includes('changelog')) return 2;
    if (name.includes('config') || name.includes('.env') || name.includes('settings')) return 2;
    
    // Main source files
    if (name.includes('index.') || name.includes('main.') || name.includes('app.')) return 3;
    if (name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.py') || name.endsWith('.go')) return 4;
    
    // Tests
    if (name.includes('test') || name.includes('spec')) return 6;
    
    // Everything else
    return 5;
  };
  
  return [...files].sort((a, b) => getFilePriority(a.filename) - getFilePriority(b.filename));
}

function getDirectoryIcon(directory: string): string {
  const dir = directory.toLowerCase();
  if (dir === '.' || dir === 'root') return '📁';
  if (dir.includes('src') || dir.includes('lib')) return '⚙️';
  if (dir.includes('test') || dir.includes('spec')) return '🧪';
  if (dir.includes('config') || dir.includes('.github')) return '⚙️';
  if (dir.includes('docs') || dir.includes('doc')) return '📚';
  if (dir.includes('assets') || dir.includes('static')) return '🎨';
  return '📂';
}

function getFileIcon(filename: string): string {
  const name = filename.toLowerCase();
  const ext = filename.split('.').pop()?.toLowerCase();
  
  // Special files
  if (name.includes('package.json')) return '📦';
  if (name.includes('dockerfile')) return '🐳';
  if (name.includes('readme')) return '📋';
  if (name.includes('changelog')) return '📝';
  if (name.includes('license')) return '⚖️';
  
  // By extension
  switch (ext) {
    case 'ts': case 'tsx': return '🔷';
    case 'js': case 'jsx': return '🟨';
    case 'py': return '🐍';
    case 'go': return '🔵';
    case 'rs': return '🦀';
    case 'java': return '☕';
    case 'cpp': case 'c': case 'cc': return '🔧';
    case 'md': return '📝';
    case 'json': case 'yaml': case 'yml': return '⚙️';
    case 'css': case 'scss': case 'sass': return '🎨';
    case 'html': return '🌐';
    case 'sql': return '🗄️';
    case 'sh': case 'bash': return '💻';
    default: return '📄';
  }
}

function getFileDisplayName(fullPath: string, directory: string): string {
  if (directory === '.') return fullPath;
  return fullPath.replace(directory + '/', '');
}

export function buildReviewSummary(
  context: Context,
  files: FileDiff[],
  commits: {
    sha: string;
    commit: {
      message: string;
    };
  }[],
  actionableComments: AIComment[],
  skippedComments: AIComment[],
  existingSummary?: string
): string {
  const { owner, repo } = context.repo;

  let body = "";
  if (actionableComments.length === 0) {
    body += `✅ **LGTM!**\n\n`;
  } else {
    body += `🚨 **Pull request needs attention.**\n\n`;
  }

  body += "### Review Summary\n\n";

  // If there's an existing summary, extract previous commits and comments
  let previousCommits: string[] = [];
  let previousActionableComments: AIComment[] = [];
  let previousSkippedComments: AIComment[] = [];

  if (existingSummary) {
    // Extract previous commits
    const commitSection = existingSummary.match(/### Commits Considered[\s\S]*?<\/details>/);
    if (commitSection) {
      previousCommits = commitSection[0].match(/\[([a-f0-9]{7})\]/g)?.map(s => s.slice(1, 8)) || [];
    }

    // Extract previous actionable comments
    const actionableSection = existingSummary.match(/### Actionable Comments[\s\S]*?<\/details>/);
    if (actionableSection) {
      const commentMatches = actionableSection[0].matchAll(/- <details>[\s\S]*?<summary>(.*?) \[(.*?)-(.*?)\]<\/summary>[\s\S]*?> (.*?): "(.*?)"[\s\S]*?<\/details>/g);
      for (const match of commentMatches) {
        previousActionableComments.push({
          file: match[1],
          start_line: parseInt(match[2]),
          end_line: parseInt(match[3]),
          label: match[4],
          header: match[5],
          content: "",  // We don't need the full content for the summary
          highlighted_code: "",
          critical: match[4].toLowerCase() === "critical",
        });
      }
    }

    // Extract previous skipped comments similarly
    const skippedSection = existingSummary.match(/### Skipped Comments[\s\S]*?<\/details>/);
    if (skippedSection) {
      const commentMatches = skippedSection[0].matchAll(/- <details>[\s\S]*?<summary>(.*?) \[(.*?)-(.*?)\]<\/summary>[\s\S]*?> (.*?): "(.*?)"[\s\S]*?<\/details>/g);
      for (const match of commentMatches) {
        previousSkippedComments.push({
          file: match[1],
          start_line: parseInt(match[2]),
          end_line: parseInt(match[3]),
          label: match[4],
          header: match[5],
          content: "",
          highlighted_code: "",
          critical: false,
        });
      }
    }
  }

  // Combine previous and new commits, removing duplicates
  const allCommits = [...previousCommits, ...commits.map(c => c.sha.slice(0, 7))];
  const uniqueCommits = [...new Set(allCommits)];

  // Commits section
  body += `<details>\n<summary>Commits Considered (${uniqueCommits.length})</summary>\n\n`;
  for (const sha of uniqueCommits) {
    const commit = commits.find(c => c.sha.startsWith(sha));
    body += `- [${sha}](https://github.com/${owner}/${repo}/commit/${sha})${commit ? `: ${commit.commit.message}` : ""}\n`;
  }
  body += "\n</details>\n\n";

  // Files section
  body += `<details>\n<summary>Files Processed (${files.length})</summary>\n\n`;
  for (const diff of files) {
    let fileText = `- ${diff.filename}`;
    if (diff.status === "renamed") {
      fileText += ` (from ${diff.previous_filename})`;
    }
    fileText += ` _(${diff.hunks.length} ${
      diff.hunks.length === 1 ? "hunk" : "hunks"
    })_`;
    body += `${fileText}\n`;
  }
  body += "\n</details>\n\n";

  // Combine previous and new comments, removing duplicates by file+line+header
  const allActionableComments = [...previousActionableComments, ...actionableComments];
  const uniqueActionableComments = allActionableComments.filter((comment, index) => {
    const key = `${comment.file}-${comment.start_line}-${comment.end_line}-${comment.header}`;
    return allActionableComments.findIndex(c =>
      `${c.file}-${c.start_line}-${c.end_line}-${c.header}` === key
    ) === index;
  });

  const allSkippedComments = [...previousSkippedComments, ...skippedComments];
  const uniqueSkippedComments = allSkippedComments.filter((comment, index) => {
    const key = `${comment.file}-${comment.start_line}-${comment.end_line}-${comment.header}`;
    return allSkippedComments.findIndex(c =>
      `${c.file}-${c.start_line}-${c.end_line}-${c.header}` === key
    ) === index;
  });

  // Actionable comments section
  body += `<details>\n<summary>Actionable Comments (${uniqueActionableComments.length})</summary>\n\n`;
  for (const comment of uniqueActionableComments) {
    body += `- <details>\n`;
    body += `  <summary>${comment.file} [${comment.start_line}-${comment.end_line}]</summary>\n\n`;
    body += `  > ${comment.label}: "${comment.header}"\n`;
    body += `  </details>\n`;
  }
  body += "\n</details>\n\n";

  // Skipped comments section
  body += `<details>\n<summary>Skipped Comments (${uniqueSkippedComments.length})</summary>\n\n`;
  for (const comment of uniqueSkippedComments) {
    body += `- <details>\n`;
    body += `  <summary>${comment.file} [${comment.start_line}-${comment.end_line}]</summary>\n\n`;
    body += `  > ${comment.label}: "${comment.header}"\n`;
    body += `  </details>\n`;
  }
  body += "</details>\n\n";

  return body;
}
