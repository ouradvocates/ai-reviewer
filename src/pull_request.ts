import { info, warning } from "@actions/core";
import config from "./config";
import { initOctokit } from "./octokit";
import { loadContext } from "./context";
import { runSummaryPrompt, AIComment, runReviewPrompt, fillPRTemplate } from "./prompts";
import {
  buildLoadingMessage,
  buildReviewSummary,
  buildOverviewMessage,
  OVERVIEW_MESSAGE_SIGNATURE,
  PAYLOAD_TAG_CLOSE,
  PAYLOAD_TAG_OPEN,
} from "./messages";
import { FileDiff, parseFileDiff } from "./diff";
import { Octokit } from "@octokit/action";
import { Context } from "@actions/github/lib/context";
import { buildComment, listPullRequestCommentThreads } from "./comments";
import { findTicketFromBranch, searchRelatedTickets, createJiraTicket, updateTicketState } from "./jira";

export async function handlePullRequest() {
  const context = await loadContext();
  if (
    context.eventName !== "pull_request" &&
    context.eventName !== "pull_request_target"
  ) {
    warning("unsupported github event");
    return;
  }

  const { pull_request } = context.payload;
  if (!pull_request) {
    warning("`pull_request` is missing from payload");
    return;
  }

  const octokit = initOctokit(config.githubToken);

  if (shouldIgnorePullRequest(pull_request)) {
    return;
  }

  // Handle PR close/merge events
  if (context.payload.action === "closed") {
    // Extract JIRA ticket key from PR description if it exists
    const ticketMatch = (pull_request.body || "").match(/\[([A-Z]+-\d+)\]/);
    if (ticketMatch) {
      const ticketKey = ticketMatch[1];
      await updateTicketState(ticketKey, pull_request.merged ? "merged" : "closed");
      return;
    }
  }

  // Only update description if this is a new PR
  if (context.payload.action === "opened" || context.payload.action === "reopened") {
    info(`PR #${pull_request.number} opened, checking description and title...`);
    info(`Current title: "${pull_request.title}"`);
    info(`Current description: ${pull_request.body || '(empty)'}`);
    
    // Get commit messages
    const { data: commits } = await octokit.rest.pulls.listCommits({
      ...context.repo,
      pull_number: pull_request.number,
    });
    info(`successfully fetched commit messages`);

    // Get modified files for description generation
    const { data: files } = await octokit.rest.pulls.listFiles({
      ...context.repo,
      pull_number: pull_request.number,
    });

    // Generate PR summary first to get a good title
    const summary = await runSummaryPrompt({
      prTitle: pull_request.title,
      prDescription: pull_request.body || "",
      commitMessages: commits.map((commit) => commit.commit.message),
      files: files,
    });

    // Try to find or create JIRA ticket
    let jiraTicket = null;
    
    // First check branch name
    if (pull_request.head.ref) {
      jiraTicket = await findTicketFromBranch(pull_request.head.ref);
    }

    // If no ticket in branch name, search for related tickets
    if (!jiraTicket) {
      jiraTicket = await searchRelatedTickets(summary.title, summary.description);
    }

    // If still no ticket, create one
    if (!jiraTicket && config.jiraDefaultProject) {
      jiraTicket = await createJiraTicket(summary.title, summary.description);
    }

    // Fill the PR template using the generated summary
    const filledTemplate = await fillPRTemplate({
      prTitle: summary.title,
      prDescription: pull_request.body || "",
      commitMessages: commits.map((commit) => commit.commit.message),
      files: files,
    });

    // Add JIRA ticket reference if found
    const description = jiraTicket 
      ? `Relates to [${jiraTicket}](${config.jiraHost}/browse/${jiraTicket})\n\n${filledTemplate}`
      : filledTemplate;

    // Update PR title and description
    await octokit.rest.pulls.update({
      ...context.repo,
      pull_number: pull_request.number,
      title: summary.title,
      body: description,
    });

    info(`Updated PR title to: "${summary.title}"`);
    info("Updated PR description with filled template");
    if (jiraTicket) {
      info(`Linked JIRA ticket: ${jiraTicket}`);
    }
  }

  // Get commit messages (moved this down since we might have already fetched it above)
  const { data: commits } = await octokit.rest.pulls.listCommits({
    ...context.repo,
    pull_number: pull_request.number,
  });
  info(`successfully fetched commit messages`);

  // Find or create overview comment with the summary
  const { data: existingComments } = await octokit.rest.issues.listComments({
    ...context.repo,
    issue_number: pull_request.number,
  });
  let overviewComment = existingComments.find((comment) =>
    comment.body?.includes(OVERVIEW_MESSAGE_SIGNATURE)
  );
  const isIncrementalReview = !!overviewComment;

  // Maybe fetch review comments
  const reviewCommentThreads = isIncrementalReview
    ? await listPullRequestCommentThreads(octokit, {
        ...context.repo,
        pull_number: pull_request.number,
      })
    : [];

  // Get modified files
  const { data: files } = await octokit.rest.pulls.listFiles({
    ...context.repo,
    pull_number: pull_request.number,
  });
  let filesToReview = files.map((file) =>
    parseFileDiff(file, reviewCommentThreads)
  );
  info(`successfully fetched file diffs`);

  let commitsReviewed: string[] = [];
  let lastCommitReviewed: string | null = null;
  if (overviewComment) {
    info(`running incremental review`);
    try {
      const payload = JSON.parse(
        overviewComment.body
          ?.split(PAYLOAD_TAG_OPEN)[1]
          .split(PAYLOAD_TAG_CLOSE)[0] || "{}"
      );
      commitsReviewed = payload.commits;
    } catch (error) {
      warning(`error parsing overview payload: ${error}`);
    }

    // Check if there are any incremental changes
    lastCommitReviewed =
      commitsReviewed.length > 0
        ? commitsReviewed[commitsReviewed.length - 1]
        : null;
    const incrementalDiff =
      lastCommitReviewed && lastCommitReviewed != pull_request.head.sha
        ? await octokit.rest.repos.compareCommits({
            ...context.repo,
            base: lastCommitReviewed,
            head: pull_request.head.sha,
          })
        : null;
    if (incrementalDiff?.data?.files) {
      // If incremental review, only consider files that were modified within incremental change.
      filesToReview = filesToReview.filter((f) =>
        incrementalDiff.data.files?.some((f2) => f2.filename === f.filename)
      );
    }
  } else {
    info(`running full review`);
  }

  const commitsToReview = commitsReviewed.length
    ? commits.filter((c) => !commitsReviewed.includes(c.sha))
    : commits;
  if (commitsToReview.length === 0) {
    info(`no new commits to review`);
    return;
  }

  if (overviewComment) {
    await octokit.rest.issues.updateComment({
      ...context.repo,
      comment_id: overviewComment.id,
      body: buildLoadingMessage(
        lastCommitReviewed ?? pull_request.base.sha,
        commitsToReview,
        filesToReview
      ),
    });
    info(`updated existing overview comment`);
  } else {
    overviewComment = (
      await octokit.rest.issues.createComment({
        ...context.repo,
        issue_number: pull_request.number,
        body: buildLoadingMessage(
          pull_request.base.sha,
          commitsToReview,
          filesToReview
        ),
      })
    ).data;
    info(`posted new overview loading comment`);
  }

  // Generate PR summary
  const summary = await runSummaryPrompt({
    prTitle: pull_request.title,
    prDescription: pull_request.body || "",
    commitMessages: commits.map((commit) => commit.commit.message),
    files: files,
  });
  info(`generated pull request summary: ${summary.title}`);

  // Update PR title if @presubmitai is mentioned in the title
  if (
    pull_request.title.includes("@presubmitai") ||
    pull_request.title.includes("@presubmit")
  ) {
    info(`title contains mention of presubmit.ai, so generating a new title`);
    await octokit.rest.pulls.update({
      ...context.repo,
      pull_number: pull_request.number,
      title: summary.title,
      // body: summary.description,
    });
  }

  // Update overview comment with the PR overview
  await octokit.rest.issues.updateComment({
    ...context.repo,
    comment_id: overviewComment.id,
    body: buildOverviewMessage(
      summary,
      commits.map((c) => c.sha)
    ),
  });
  info(`updated overview comment with walkthrough`);

  // ======= START REVIEW =======

  const review = await runReviewPrompt({
    files: filesToReview,
    prTitle: pull_request.title,
    prDescription: pull_request.body || "",
    prSummary: summary.description,
  });
  info(`reviewed pull request`);

  // Post review comments
  const comments = review.comments.filter(
    (c) => c.content.trim() !== "" && files.some((f) => f.filename === c.file)
  );
  await submitReview(
    octokit,
    context,
    {
      number: pull_request.number,
      headSha: pull_request.head.sha,
    },
    comments,
    commitsToReview,
    filesToReview
  );
  info(`posted review comments`);
}

async function submitReview(
  octokit: Octokit,
  context: Context,
  pull_request: {
    number: number;
    headSha: string;
  },
  comments: AIComment[],
  commits: {
    sha: string;
    commit: {
      message: string;
    };
  }[],
  files: FileDiff[]
) {
  const submitInlineComment = async (
    file: string,
    line: number,
    content: string
  ) => {
    await octokit.pulls.createReviewComment({
      ...context.repo,
      pull_number: pull_request.number,
      commit_id: pull_request.headSha,
      path: file,
      body: buildComment(content),
      line,
    });
  };

  // Handle file comments
  const fileComments = comments.filter((c) => !c.end_line);
  if (fileComments.length > 0) {
    const responses = await Promise.allSettled(
      fileComments.map((c) => submitInlineComment(c.file, -1, c.content))
    );

    for (const response of responses) {
      if (response.status === "rejected") {
        warning(`error creating file comment: ${response.reason}`);
      }
    }
  }

  // Handle line comments
  let lineComments = [];
  let skippedComments = [];
  for (const comment of comments) {
    if (comment.critical || comment.label === "typo") {
      lineComments.push(comment);
    } else {
      skippedComments.push(comment);
    }
  }

  // Try to submit all comments at once
  try {
    let commentsData = lineComments.map((c) => ({
      path: c.file,
      body: buildComment(c.content),
      line: c.end_line,
      side: "RIGHT",
      start_line:
        c.start_line && c.start_line < c.end_line ? c.start_line : undefined,
      start_side:
        c.start_line && c.start_line < c.end_line ? "RIGHT" : undefined,
    }));

    // Find existing review summary
    const { data: reviews } = await octokit.pulls.listReviews({
      ...context.repo,
      pull_number: pull_request.number,
    });

    const lastReview = reviews
      .reverse()
      .find(r => r.body?.includes("### Review Summary"));

    // Build new review summary
    const newSummary = buildReviewSummary(
      context,
      files,
      commits,
      lineComments,
      skippedComments,
      lastReview?.body // Pass existing summary to be extended
    );

    const review = await octokit.pulls.createReview({
      ...context.repo,
      pull_number: pull_request.number,
      commit_id: pull_request.headSha,
      comments: commentsData,
    });

    await octokit.pulls.submitReview({
      ...context.repo,
      pull_number: pull_request.number,
      review_id: review.data.id,
      event: "COMMENT",
      body: newSummary,
    });
  } catch (error) {
    warning(`error submitting review: ${error}`);

    // If submitting all comments at once fails, try submitting them one by one
    info("trying to submit comments one by one");
    await Promise.allSettled(
      lineComments.map((c) =>
        submitInlineComment(c.file, c.end_line, c.content)
      )
    );
  }
}

function shouldIgnorePullRequest(pull_request: { body?: string }) {
  const ignorePhrases = [
    "@presubmit ignore",
    "@presubmit: ignore",
    "@presubmit skip",
    "@presubmit: skip",
    "@presubmitai ignore",
    "@presubmitai: ignore",
    "@presubmitai skip",
    "@presubmitai: skip",
  ];
  const bodyLower = (pull_request.body ?? "").toLowerCase();

  for (const phrase of ignorePhrases) {
    if (bodyLower.includes(phrase.toLowerCase())) {
      info(`ignoring pull request because of '${phrase}' in description`);
      return true;
    }
  }
  return false;
}
