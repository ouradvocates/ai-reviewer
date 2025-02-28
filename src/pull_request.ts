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
import { 
  findTicketFromBranch, 
  searchRelatedTickets, 
  createJiraTicket, 
  updateTicketState, 
  findTicketsInCommitMessages, 
  getTicketType, 
  associateTicketWithEpic, 
  isEpic 
} from "./jira";

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

  // Get commit messages for both PR open and close events
  const { data: commits } = await octokit.rest.pulls.listCommits({
    ...context.repo,
    pull_number: pull_request.number,
  });
  info(`successfully fetched commit messages`);
  const commitMessages = commits.map((commit) => commit.commit.message);

  // Handle PR close/merge events
  if (context.payload.action === "closed") {
    // First check for tickets in PR description
    const ticketsFromDescription: string[] = [];
    const ticketMatches = [...(pull_request.body || "").matchAll(/\[([A-Z]+-\d+)\]/g)];
    
    if (ticketMatches.length > 0) {
      for (const match of ticketMatches) {
        ticketsFromDescription.push(match[1]);
      }
      info(`Found ticket keys in PR description: ${ticketsFromDescription.join(', ')}`);
    }
    
    // Then check for tickets in commit messages
    const ticketsFromCommits = await findTicketsInCommitMessages(commitMessages);
    info(`Found ticket keys in commit messages: ${ticketsFromCommits.join(', ')}`);
    
    // Combine all found tickets
    const allTickets = [...new Set([...ticketsFromDescription, ...ticketsFromCommits])];
    
    if (allTickets.length > 0) {
      info(`Processing ${allTickets.length} JIRA tickets: ${allTickets.join(', ')}`);
      
      // Update state for each ticket based on type
      for (const ticketKey of allTickets) {
        await updateTicketState(ticketKey, pull_request.merged ? "merged" : "closed");
      }
    } else {
      warning('No JIRA ticket keys found in PR description or commit messages');
    }
    
    return;
  }

  // Only update description if this is a new PR
  if (context.payload.action === "opened" || context.payload.action === "reopened") {
    info(`PR #${pull_request.number} opened, checking description and title...`);
    info(`Current title: "${pull_request.title}"`);
    info(`Current description: ${pull_request.body || '(empty)'}`);
    
    // Get modified files for description generation
    const { data: files } = await octokit.rest.pulls.listFiles({
      ...context.repo,
      pull_number: pull_request.number,
    });

    // Generate PR summary first to get a good title
    const summary = await runSummaryPrompt({
      prTitle: pull_request.title,
      prDescription: pull_request.body || "",
      commitMessages: commitMessages,
      files: files,
    });

    // Try to find JIRA tickets
    let jiraTickets: string[] = [];
    let primaryTicket: string | null = null;
    let epicTicket: string | null = null;
    
    // First check branch name
    if (pull_request.head.ref) {
      const branchTicket = await findTicketFromBranch(pull_request.head.ref);
      if (branchTicket) {
        jiraTickets.push(branchTicket);
        primaryTicket = branchTicket;
      }
    }
    
    // Then check commit messages
    const commitTickets = await findTicketsInCommitMessages(commitMessages);
    
    // Add any new tickets found in commits
    for (const ticket of commitTickets) {
      if (!jiraTickets.includes(ticket)) {
        jiraTickets.push(ticket);
        // If we don't have a primary ticket yet, use the first one from commits
        if (!primaryTicket) {
          primaryTicket = ticket;
        }
      }
    }
    
    // If no tickets found yet, search for related tickets
    if (jiraTickets.length === 0) {
      const relatedTicket = await searchRelatedTickets(summary.title, summary.description);
      if (relatedTicket) {
        jiraTickets.push(relatedTicket);
        primaryTicket = relatedTicket;
      }
    }

    // If still no tickets, create one
    if (jiraTickets.length === 0 && config.jiraDefaultProject) {
      // Try to get the user's email from the commit
      let userEmail;
      if (commits.length > 0 && commits[0].commit.author) {
        userEmail = commits[0].commit.author.email;
        info(`Found GitHub user email from commit: ${userEmail}`);
      }

      const newTicket = await createJiraTicket(
        summary.title, 
        summary.description,
        pull_request.user.login, // Pass the GitHub username of the PR opener
        {
          prUrl: pull_request.html_url,
          prNumber: pull_request.number,
          branchName: pull_request.head.ref,
          files: files.map(f => ({ 
            filename: f.filename,
            status: f.status
          })),
          commitMessages: commitMessages,
          userEmail // Pass the GitHub user's email
        }
      );
      
      if (newTicket) {
        jiraTickets.push(newTicket);
        primaryTicket = newTicket;
      }
    }
    
    // Categorize tickets and find Epics
    const ticketTypes: Record<string, string> = {};
    
    for (const ticket of jiraTickets) {
      const ticketType = await getTicketType(ticket);
      if (ticketType) {
        ticketTypes[ticket] = ticketType;
        
        // If this is an Epic, mark it
        if (ticketType === 'Epic') {
          epicTicket = ticket;
        }
      }
    }
    
    // If we found tickets but no Epic, try to find a related Epic
    if (jiraTickets.length > 0 && !epicTicket && primaryTicket) {
      // Try to find an Epic to associate with
      for (const ticket of jiraTickets) {
        if (ticket !== primaryTicket && ticketTypes[ticket] !== 'Epic') {
          // Link non-primary, non-Epic tickets to the primary ticket
          await associateTicketWithEpic(ticket, primaryTicket);
        }
      }
    }
    
    // Fill the PR template using the generated summary
    const filledTemplate = await fillPRTemplate({
      prTitle: summary.title,
      prDescription: pull_request.body || "",
      commitMessages: commitMessages,
      files: files,
    });

    // Build ticket references for PR description
    let ticketReferences = '';
    if (jiraTickets.length > 0) {
      // Group tickets by type
      const ticketsByType: Record<string, string[]> = {};
      
      for (const ticket of jiraTickets) {
        const type = ticketTypes[ticket] || 'Task';
        if (!ticketsByType[type]) {
          ticketsByType[type] = [];
        }
        ticketsByType[type].push(ticket);
      }
      
      // Build references section
      ticketReferences = '## JIRA References\n\n';
      
      for (const type in ticketsByType) {
        ticketReferences += `### ${type}s\n`;
        for (const ticket of ticketsByType[type]) {
          ticketReferences += `- [${ticket}](${config.jiraHost}/browse/${ticket})\n`;
        }
        ticketReferences += '\n';
      }
    }

    // Add JIRA ticket references to description
    const description = jiraTickets.length > 0
      ? `${ticketReferences}\n${filledTemplate}`
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
    if (jiraTickets.length > 0) {
      info(`Linked JIRA tickets: ${jiraTickets.join(', ')}`);
    }
  }

  // Continue with the rest of the function for review generation
  // We'll reuse the commits and commitMessages variables from above
  
  // Maybe fetch review comments
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
  const { data: filesToDiff } = await octokit.rest.pulls.listFiles({
    ...context.repo,
    pull_number: pull_request.number,
  });
  let filesToReview = filesToDiff.map((file) =>
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
  const reviewSummary = await runSummaryPrompt({
    prTitle: pull_request.title,
    prDescription: pull_request.body || "",
    commitMessages: commitMessages,
    files: filesToDiff,
  });
  info(`generated pull request summary: ${reviewSummary.title}`);

  // Update PR title if @presubmitai is mentioned in the title
  if (
    pull_request.title.includes("@presubmitai") ||
    pull_request.title.includes("@presubmit")
  ) {
    info(`title contains mention of presubmit.ai, so generating a new title`);
    await octokit.rest.pulls.update({
      ...context.repo,
      pull_number: pull_request.number,
      title: reviewSummary.title,
      // body: summary.description,
    });
  }

  // Update overview comment with the PR overview
  await octokit.rest.issues.updateComment({
    ...context.repo,
    comment_id: overviewComment.id,
    body: buildOverviewMessage(
      reviewSummary,
      commits.map((c) => c.sha)
    ),
  });
  info(`updated overview comment with walkthrough`);

  // ======= START REVIEW =======

  const review = await runReviewPrompt({
    files: filesToReview,
    prTitle: pull_request.title,
    prDescription: pull_request.body || "",
    prSummary: reviewSummary.description,
  });
  info(`reviewed pull request`);

  // Post review comments
  const comments = review.comments.filter(
    (c) => c.content.trim() !== "" && filesToDiff.some((f) => f.filename === c.file)
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
