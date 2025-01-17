import { info, warning } from "@actions/core";
import config from "./config";

interface JiraTicket {
  key: string;
  fields: {
    summary: string;
    description: string;
  };
}

interface JiraTransition {
  id: string;
  name: string;
}

export async function findTicketFromBranch(branchName: string): Promise<string | null> {
  // Common JIRA ticket patterns: PROJECT-123, PRJ-123, etc.
  const ticketPattern = /([A-Z]+-\d+)/;
  const match = branchName.match(ticketPattern);
  
  if (match) {
    const ticketKey = match[1];
    try {
      const ticket = await getJiraTicket(ticketKey);
      if (ticket) {
        info(`Found JIRA ticket ${ticketKey} from branch name`);
        return ticketKey;
      }
    } catch (error) {
      warning(`Error fetching JIRA ticket ${ticketKey}: ${error}`);
    }
  }
  return null;
}

export async function searchRelatedTickets(title: string, description: string): Promise<string | null> {
  const jql = encodeURIComponent(
    `project in (${config.jiraProjects}) AND status in ("Open", "In Progress") AND text ~ "${title}"`
  );
  
  try {
    const response = await fetch(`${config.jiraHost}/rest/api/2/search?jql=${jql}`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`JIRA API error: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.issues && data.issues.length > 0) {
      const ticket = data.issues[0];
      info(`Found related JIRA ticket ${ticket.key}`);
      return ticket.key;
    }
  } catch (error) {
    warning(`Error searching JIRA tickets: ${error}`);
  }
  return null;
}

export async function createJiraTicket(title: string, description: string): Promise<string | null> {
  try {
    const response = await fetch(`${config.jiraHost}/rest/api/2/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          project: { key: config.jiraDefaultProject },
          summary: title,
          description: description,
          issuetype: { name: 'Task' }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`JIRA API error: ${response.statusText}`);
    }

    const data = await response.json();
    const ticketKey = data.key;
    
    // Set initial state to "In Review"
    await transitionTicket(ticketKey, "In Review");
    
    info(`Created new JIRA ticket ${ticketKey}`);
    return ticketKey;
  } catch (error) {
    warning(`Error creating JIRA ticket: ${error}`);
    return null;
  }
}

export async function updateTicketState(ticketKey: string, prState: "closed" | "merged"): Promise<void> {
  try {
    const targetState = prState === "merged" ? "Shipped" : "Closed";
    await transitionTicket(ticketKey, targetState);
    info(`Updated JIRA ticket ${ticketKey} to ${targetState}`);
  } catch (error) {
    warning(`Error updating JIRA ticket ${ticketKey} state: ${error}`);
  }
}

async function transitionTicket(ticketKey: string, targetState: string): Promise<void> {
  try {
    // Get available transitions
    const transitions = await getAvailableTransitions(ticketKey);
    const transition = transitions.find(t => t.name.toLowerCase() === targetState.toLowerCase());
    
    if (!transition) {
      warning(`No transition found to state "${targetState}" for ticket ${ticketKey}`);
      return;
    }

    // Perform the transition
    const response = await fetch(`${config.jiraHost}/rest/api/2/issue/${ticketKey}/transitions`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        transition: { id: transition.id }
      })
    });

    if (!response.ok) {
      throw new Error(`JIRA API error: ${response.statusText}`);
    }
  } catch (error) {
    throw new Error(`Failed to transition ticket ${ticketKey}: ${error}`);
  }
}

async function getAvailableTransitions(ticketKey: string): Promise<JiraTransition[]> {
  try {
    const response = await fetch(`${config.jiraHost}/rest/api/2/issue/${ticketKey}/transitions`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`JIRA API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.transitions || [];
  } catch (error) {
    throw new Error(`Failed to get transitions for ticket ${ticketKey}: ${error}`);
  }
}

async function getJiraTicket(ticketKey: string): Promise<JiraTicket | null> {
  try {
    const response = await fetch(`${config.jiraHost}/rest/api/2/issue/${ticketKey}`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`JIRA API error: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    warning(`Error fetching JIRA ticket: ${error}`);
    return null;
  }
} 