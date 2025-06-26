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

  for (const file of summary.files) {
    message += `**${file.filename}**\n${file.summary}\n\n`;
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
