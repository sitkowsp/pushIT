const db = require('../db/db');

/**
 * Process a message through all active filters for a user.
 * Returns an array of actions to take.
 */
async function processFilters(userId, message) {
  const filters = db.all(
    'SELECT * FROM filters WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC',
    [userId]
  );

  const actions = [];

  for (const filter of filters) {
    if (matchesFilter(filter, message)) {
      actions.push({
        filterId: filter.id,
        filterName: filter.name,
        action: filter.action,
        webhookUrl: filter.action_webhook_url,
        overridePriority: filter.action_override_priority,
        overrideSound: filter.action_override_sound,
        suppress: filter.action_suppress === 1,
        autoAcknowledge: filter.action_auto_acknowledge === 1,
      });

      // If this filter suppresses, stop processing further filters
      if (filter.action_suppress) break;
    }
  }

  return actions;
}

/**
 * Check if a message matches a filter's criteria.
 */
function matchesFilter(filter, message) {
  // Match by app token
  if (filter.match_app_token && message.app_token !== filter.match_app_token) {
    return false;
  }

  // Match by title pattern (regex)
  if (filter.match_title_pattern) {
    try {
      const regex = new RegExp(filter.match_title_pattern, 'i');
      if (!regex.test(message.title || '')) return false;
    } catch (e) {
      // Invalid regex, skip this criterion
    }
  }

  // Match by message pattern (regex)
  if (filter.match_message_pattern) {
    try {
      const regex = new RegExp(filter.match_message_pattern, 'i');
      if (!regex.test(message.message || '')) return false;
    } catch (e) {
      // Invalid regex, skip this criterion
    }
  }

  // Match by priority range
  if (filter.match_priority_min !== null && message.priority < filter.match_priority_min) {
    return false;
  }
  if (filter.match_priority_max !== null && message.priority > filter.match_priority_max) {
    return false;
  }

  return true;
}

/**
 * Execute filter actions (forward to webhook, modify priority, etc.)
 */
async function executeFilterActions(actions, message, originalPayload) {
  const modifications = {};
  let suppress = false;

  for (const action of actions) {
    // Forward to webhook
    if (action.action === 'forward' && action.webhookUrl) {
      try {
        await forwardToWebhook(action.webhookUrl, message, action.filterId);
      } catch (err) {
        console.error(`[Filter] Webhook forward failed for filter ${action.filterId}:`, err.message);
      }
    }

    // Override priority
    if (action.overridePriority !== null) {
      modifications.priority = action.overridePriority;
    }

    // Override sound
    if (action.overrideSound) {
      modifications.sound = action.overrideSound;
    }

    // Suppress notification
    if (action.suppress) {
      suppress = true;
    }

    // Auto-acknowledge (for emergency priority)
    if (action.autoAcknowledge && message.receipt) {
      modifications.autoAcknowledge = true;
    }
  }

  return { modifications, suppress };
}

/**
 * Forward a message to an external webhook (typically n8n).
 */
async function forwardToWebhook(url, message, filterId) {
  const { v4: uuidv4 } = require('uuid');
  const payload = {
    event: 'message.filtered',
    message_id: message.id,
    title: message.title,
    message: message.message,
    priority: message.priority,
    user_id: message.user_id,
    app_token: message.app_token,
    url: message.url,
    timestamp: message.timestamp || new Date().toISOString(),
    filter_id: filterId,
  };

  let statusCode = null;
  let responseBody = null;
  let success = false;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    statusCode = response.status;
    responseBody = await response.text();
    success = response.ok;
  } catch (err) {
    responseBody = err.message;
  }

  // Log the delivery attempt
  db.run(
    `INSERT INTO webhook_deliveries (id, message_id, filter_id, webhook_url, payload, status_code, response_body, success)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), message.id, filterId, url, JSON.stringify(payload), statusCode, responseBody, success ? 1 : 0]
  );

  return success;
}

module.exports = {
  processFilters,
  executeFilterActions,
  forwardToWebhook,
};
