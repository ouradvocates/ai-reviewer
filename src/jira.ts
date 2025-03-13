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
    assignee?: {
      accountId?: string;
      name?: string;
    };
    status?: {
      name: string;
      id?: string;
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

// Pre-defined mapping from GitHub usernames to JIRA emails
const GITHUB_TO_JIRA_MAP: Record<string, string> = {
  'srslafazan': 'shain.lafazan@ouradvocates.com',
  "BillBabeaux": "bill.babeaux@ouradvocates.com",
  "bryanmorganoverbey": "bryan.overbey@ouradvocates.com",
  "CharleyLanusse": "charley@ouradvocates.com",
  "gordondri": "gordon.dri@ouradvocates.com",
  "j314159": "josh.miller@ouradvocates.com",
  "kylewhitaker": "kyle.whitaker@ouradvocates.com",
  "Paradxil": "hunter.stratton@ouradvocates.com",
  "rhymeswithlion": "brian.cruz@ouradvocates.com",
  "taharbenoudjit": "tahar.benoudjit@ouradvocates.com",
  "davidhudman": "david.hudman@ouradvocates.com",
};

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

export async function createJiraTicket(
  title: string, 
  description: string, 
  githubUsername?: string,
  prContext?: {
    prUrl?: string;
    prNumber?: number;
    branchName?: string;
    files?: Array<{ filename: string; status: string }>;
    commitMessages?: string[];
    userEmail?: string; // GitHub user email
  }
): Promise<string | null> {
  try {
    // Build a detailed description
    let detailedDescription = `h2. Overview\n${description}\n\n`;

    if (prContext) {
      // Add PR information
      detailedDescription += `h2. Implementation Details\n`;
      if (prContext.prUrl) {
        detailedDescription += `* Pull Request: ${prContext.prUrl}\n`;
      }
      if (prContext.branchName) {
        detailedDescription += `* Implementation Branch: ${prContext.branchName}\n`;
      }

      // Analyze and group changes by feature/component
      if (prContext.files && prContext.files.length > 0) {
        const componentChanges = new Map<string, string[]>();
        
        prContext.files.forEach(file => {
          // Extract component from file path (e.g., src/auth/login.ts -> auth)
          const component = file.filename.split('/').slice(0, -1).pop() || 'other';
          const changes = componentChanges.get(component) || [];
          changes.push(file.filename);
          componentChanges.set(component, changes);
        });

        if (componentChanges.size > 0) {
          detailedDescription += `\nh2. Components Modified\n`;
          for (const [component, files] of componentChanges) {
            detailedDescription += `h3. ${component.charAt(0).toUpperCase() + component.slice(1)}\n`;
            detailedDescription += `* Number of files modified: ${files.length}\n`;
          }
        }
      }

      // Extract feature information from commit messages
      if (prContext.commitMessages && prContext.commitMessages.length > 0) {
        detailedDescription += `\nh2. Feature Implementation\n`;
        
        // Group similar commits and extract feature information
        const features = new Set<string>();
        prContext.commitMessages.forEach(msg => {
          const firstLine = msg.split('\n')[0].toLowerCase();
          if (firstLine.startsWith('feat:') || firstLine.startsWith('feature:')) {
            features.add(msg.split('\n')[0].substring(firstLine.indexOf(':') + 1).trim());
          }
        });

        if (features.size > 0) {
          detailedDescription += `h3. Features Added/Modified\n`;
          features.forEach(feature => {
            detailedDescription += `* ${feature}\n`;
          });
        }

        // Add implementation notes based on commit messages
        detailedDescription += `\nh3. Implementation Notes\n`;
        const implementationNotes = prContext.commitMessages
          .map(msg => msg.split('\n')[0])
          .filter(msg => !msg.toLowerCase().startsWith('feat:') && !msg.toLowerCase().startsWith('feature:'))
          .map(msg => {
            // Clean up commit message to be more readable
            msg = msg.replace(/^(fix|chore|refactor|style|test|docs):\s*/i, '');
            return msg.charAt(0).toUpperCase() + msg.slice(1);
          });

        implementationNotes.forEach(note => {
          detailedDescription += `* ${note}\n`;
        });
      }
    }

    // Add technical impact section
    detailedDescription += `\nh2. Technical Impact\n`;
    if (prContext?.files) {
      const impactPoints = [];
      const testFiles = prContext.files.filter(f => f.filename.includes('test') || f.filename.includes('spec'));
      const configFiles = prContext.files.filter(f => f.filename.includes('config') || f.filename.endsWith('.json') || f.filename.endsWith('.yml'));
      
      if (testFiles.length > 0) {
        impactPoints.push(`* Test Coverage: Added/modified ${testFiles.length} test files`);
      }
      if (configFiles.length > 0) {
        impactPoints.push(`* Configuration Changes: Updated ${configFiles.length} configuration files`);
      }
      
      if (impactPoints.length > 0) {
        detailedDescription += impactPoints.join('\n') + '\n';
      }
    }

    // Add creation context
    detailedDescription += `\nh2. Metadata\n`;
    detailedDescription += `* Created by: AI Reviewer\n`;
    if (githubUsername) {
      detailedDescription += `* Implementation Author: ${githubUsername}\n`;
    }
    detailedDescription += `* Created on: ${new Date().toISOString().split('T')[0]}\n`;

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
          description: detailedDescription,
          issuetype: { name: 'Task' }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`JIRA API error: ${response.statusText}`);
    }

    const data = await response.json();
    const ticketKey = data.key;
    
    // Since this is a new ticket created by the AI reviewer,
    // try to assign it to the GitHub user
    if (githubUsername) {
      const jiraAccountId = await findJiraUser(githubUsername, prContext?.userEmail);
      if (jiraAccountId) {
        await assignTicketToUser(ticketKey, jiraAccountId);
      }
    }
    
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

export async function findTicketsInCommitMessages(commitMessages: string[]): Promise<string[]> {
  // Common JIRA ticket patterns: PROJECT-123, PRJ-123, etc.
  const ticketPattern = /([A-Z]+-\d+)/g;
  const foundTickets = new Set<string>();
  
  for (const message of commitMessages) {
    const matches = [...message.matchAll(ticketPattern)];
    if (matches.length > 0) {
      matches.forEach(match => {
        const ticketKey = match[1];
        foundTickets.add(ticketKey);
      });
    }
  }
  
  // Validate that these are actual tickets
  const validatedTickets: string[] = [];
  for (const ticketKey of foundTickets) {
    try {
      const ticket = await getJiraTicket(ticketKey);
      if (ticket) {
        info(`Found JIRA ticket ${ticketKey} in commit messages`);
        validatedTickets.push(ticketKey);
      }
    } catch (error) {
      warning(`Error fetching JIRA ticket ${ticketKey}: ${error}`);
    }
  }
  
  return validatedTickets;
}

export async function getTicketType(ticketKey: string): Promise<string | null> {
  try {
    const ticket = await getJiraTicket(ticketKey);
    return ticket?.fields?.issuetype?.name || null;
  } catch (error) {
    warning(`Error getting ticket type for ${ticketKey}: ${error}`);
    return null;
  }
}

async function isTicketInState(ticketKey: string, stateName: string): Promise<boolean> {
  try {
    const ticket = await getJiraTicket(ticketKey);
    return ticket?.fields?.status?.name?.toLowerCase() === stateName.toLowerCase();
  } catch (error) {
    warning(`Error checking ticket state for ${ticketKey}: ${error}`);
    return false;
  }
}

export async function updateTicketState(ticketKey: string, prState: "closed" | "merged"): Promise<void> {
  try {
    // Only transition if PR is merged
    if (prState !== "merged") {
      info(`PR was closed but not merged, not updating JIRA ticket ${ticketKey}`);
      return;
    }
    
    // Check ticket type
    const ticketType = await getTicketType(ticketKey);
    info(`Ticket ${ticketKey} is of type: ${ticketType || 'unknown'}`);
    
    // Don't close Epics
    if (ticketType === "Epic") {
      info(`Not closing Epic ticket ${ticketKey} as requested`);
      return;
    }
    
    // For Story, Task, Bug, or other non-Epic types, transition to Shipped
    const targetState = "Shipped";
    
    // Check if the ticket is already in the target state
    if (await isTicketInState(ticketKey, targetState)) {
      info(`Ticket ${ticketKey} is already in ${targetState} state`);
      return;
    }
    
    // Log the specific ticket type being transitioned
    if (ticketType) {
      info(`Transitioning ${ticketType} ticket ${ticketKey} to ${targetState}`);
    } else {
      info(`Transitioning ticket ${ticketKey} to ${targetState}`);
    }
    
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

export async function associateTicketWithEpic(ticketKey: string, epicKey: string): Promise<void> {
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

export async function isEpic(ticketKey: string): Promise<boolean> {
  try {
    const ticket = await getJiraTicket(ticketKey);
    return ticket?.fields?.issuetype?.name === 'Epic';
  } catch (error) {
    warning(`Error checking if ticket ${ticketKey} is an Epic: ${error}`);
    return false;
  }
}

async function findJiraUser(githubUsername: string, githubEmail?: string): Promise<string | null> {
  try {
    // First check if we have a pre-defined mapping
    const mappedEmail = GITHUB_TO_JIRA_MAP[githubUsername];
    if (mappedEmail) {
      info(`Using pre-defined JIRA email mapping for ${githubUsername}: ${mappedEmail}`);
      
      // Search JIRA by the mapped email
      const response = await fetch(`${config.jiraHost}/rest/api/2/user/search?query=${encodeURIComponent(mappedEmail)}`, {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64')}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`JIRA API error: ${response.statusText}`);
      }

      const users = await response.json();
      if (users && users.length > 0) {
        info(`Found JIRA user by mapped email: ${mappedEmail}`);
        return users[0].accountId;
      }
    }

    // If no mapping or mapping didn't yield results, try username
    let response = await fetch(`${config.jiraHost}/rest/api/2/user/search?query=${encodeURIComponent(githubUsername)}`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`JIRA API error: ${response.statusText}`);
    }

    let users = await response.json();
    if (users && users.length > 0) {
      info(`Found JIRA user by GitHub username: ${githubUsername}`);
      return users[0].accountId;
    }

    // If no match by username and we have an email from GitHub, try that
    if (githubEmail) {
      response = await fetch(`${config.jiraHost}/rest/api/2/user/search?query=${encodeURIComponent(githubEmail)}`, {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64')}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`JIRA API error: ${response.statusText}`);
      }

      users = await response.json();
      if (users && users.length > 0) {
        info(`Found JIRA user by GitHub email: ${githubEmail}`);
        return users[0].accountId;
      }
    }

    warning(`No matching JIRA user found for GitHub user ${githubUsername}${githubEmail ? ` with email ${githubEmail}` : ''}`);
  } catch (error) {
    warning(`Error finding JIRA user for GitHub username ${githubUsername}: ${error}`);
  }
  return null;
}

async function assignTicketToUser(ticketKey: string, accountId: string): Promise<void> {
  try {
    const response = await fetch(`${config.jiraHost}/rest/api/2/issue/${ticketKey}/assignee`, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accountId: accountId
      })
    });

    if (!response.ok) {
      throw new Error(`JIRA API error: ${response.statusText}`);
    }

    info(`Successfully assigned ticket ${ticketKey} to user ${accountId}`);
  } catch (error) {
    warning(`Error assigning ticket ${ticketKey} to user: ${error}`);
  }
} 