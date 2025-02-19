import { info, warning } from "@actions/core";
import config from "./config";

interface JiraTicket {
  key: string;
  fields: {
    summary: string;
    description: string;
    customfield_10014?: string; // Epic link field
    issuetype?: {
      name: string;
    };
  };
}

interface JiraTransition {
  id: string;
  name: string;
}

interface JiraEpic {
  key: string;
  fields: {
    summary: string;
    description: string;
  };
}

export async function findTicketFromBranch(branchName: string): Promise<string | null> {
  // Common JIRA ticket patterns: PROJECT-123, PRJ-123, etc.
  const ticketPattern = /([A-Z]+-\d+)/g;
  const matches = [...branchName.matchAll(ticketPattern)];
  
  if (matches.length > 0) {
    const ticketKeys = matches.map(match => match[1]);
    
    // If we have multiple tickets, check if one is an Epic
    if (ticketKeys.length > 1) {
      for (let i = 0; i < ticketKeys.length; i++) {
        try {
          const ticket = await getJiraTicket(ticketKeys[i]);
          if (ticket) {
            info(`Found JIRA ticket ${ticketKeys[i]} from branch name`);
            
            // Check if any other ticket is an Epic
            for (let j = 0; j < ticketKeys.length; j++) {
              if (i !== j) {
                const otherTicket = await getJiraTicket(ticketKeys[j]);
                if (otherTicket && await isEpic(ticketKeys[j])) {
                  await associateTicketWithEpic(ticketKeys[i], ticketKeys[j]);
                }
              }
            }
            
            return ticketKeys[i];
          }
        } catch (error) {
          warning(`Error fetching JIRA ticket ${ticketKeys[i]}: ${error}`);
        }
      }
    } else if (matches.length === 1) {
      const ticketKey = ticketKeys[0];
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
    
    // Try to find and associate with an Epic
    const epicKey = await findEpicBySemanticMatch(title, description);
    if (epicKey) {
      await associateTicketWithEpic(ticketKey, epicKey);
    }
    
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
    info(`Attempting to transition JIRA ticket ${ticketKey} to ${targetState}`);
    await transitionTicket(ticketKey, targetState);
    info(`Successfully updated JIRA ticket ${ticketKey} to ${targetState}`);
  } catch (error) {
    warning(`Error updating JIRA ticket ${ticketKey} state: ${error}`);
    // Log the full error for debugging
    console.error(error);
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

async function findEpicBySemanticMatch(ticketSummary: string, ticketDescription: string): Promise<string | null> {
  // Search for Epics in the project
  const jql = encodeURIComponent(
    `project in (${config.jiraProjects}) AND issuetype = Epic AND status != Closed`
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
    if (!data.issues || data.issues.length === 0) {
      return null;
    }

    // Find the most relevant Epic by comparing summaries
    const epics = data.issues;
    let bestMatch: { key: string; score: number } | null = null;

    for (const epic of epics) {
      const score = calculateRelevanceScore(
        epic.fields.summary + ' ' + (epic.fields.description || ''),
        ticketSummary + ' ' + ticketDescription
      );

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { key: epic.key, score };
      }
    }

    // Only return if we have a reasonably good match
    if (bestMatch && bestMatch.score > 0.3) {
      info(`Found matching Epic ${bestMatch.key} with score ${bestMatch.score}`);
      return bestMatch.key;
    }
  } catch (error) {
    warning(`Error searching for Epics: ${error}`);
  }
  return null;
}

function calculateRelevanceScore(epicText: string, ticketText: string): number {
  // Simple word matching algorithm
  const epicWords = new Set(epicText.toLowerCase().split(/\s+/));
  const ticketWords = ticketText.toLowerCase().split(/\s+/);
  
  let matchCount = 0;
  for (const word of ticketWords) {
    if (epicWords.has(word) && word.length > 3) { // Only count meaningful words
      matchCount++;
    }
  }
  
  return matchCount / Math.max(epicWords.size, ticketWords.length);
}

async function associateTicketWithEpic(ticketKey: string, epicKey: string): Promise<void> {
  try {
    const response = await fetch(`${config.jiraHost}/rest/api/2/issue/${ticketKey}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          customfield_10014: epicKey // Epic link field
        }
      })
    });

    if (!response.ok) {
      throw new Error(`JIRA API error: ${response.statusText}`);
    }

    info(`Successfully associated ticket ${ticketKey} with Epic ${epicKey}`);
  } catch (error) {
    warning(`Error associating ticket with Epic: ${error}`);
  }
}

async function isEpic(ticketKey: string): Promise<boolean> {
  try {
    const ticket = await getJiraTicket(ticketKey);
    return ticket?.fields?.issuetype?.name === 'Epic';
  } catch (error) {
    warning(`Error checking if ticket ${ticketKey} is an Epic: ${error}`);
    return false;
  }
} 