import { warning, setFailed } from "@actions/core";
import { handlePullRequest } from "./pull_request";
import { handlePullRequestComment } from "./pull_request_comment";

async function main(): Promise<void> {
  try {
    switch (process.env.GITHUB_EVENT_NAME) {
      case "pull_request":
      case "pull_request_target":
        await handlePullRequest();
        break;
      case "pull_request_review_comment":
        await handlePullRequestComment();
        break;
      default:
        warning("Skipped: unsupported github event");
    }
  } catch (error) {
    setFailed(`Failed with error: ${describeError(error)}`);
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const responseBody = (error as { responseBody?: unknown }).responseBody;
  if (typeof responseBody !== "string" || responseBody.trim() === "") return error.message;
  const snippet = responseBody.replace(/\s+/g, " ").slice(0, 500);
  return `${error.message}: ${snippet}`;
}

main();
