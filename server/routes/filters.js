const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../db/db');
const { authenticateUser } = require('../middleware/auth');

/**
 * GET /api/v1/filters
 * List all filters for the authenticated user.
 */
router.get('/', authenticateUser, (req, res) => {
  const filters = db.all(
    'SELECT * FROM filters WHERE user_id = ? ORDER BY sort_order ASC',
    [req.dbUser.id]
  );

  res.json({ status: 1, filters });
});

/**
 * POST /api/v1/filters
 * Create a new notification filter.
 */
router.post('/', authenticateUser, (req, res) => {
  const {
    name,
    match_app_token,
    match_title_pattern,
    match_message_pattern,
    match_priority_min,
    match_priority_max,
    action = 'forward',
    action_webhook_url,
    action_override_priority,
    action_override_sound,
    action_suppress = false,
    action_auto_acknowledge = false,
    sort_order = 0,
  } = req.body;

  if (!name) {
    return res.status(400).json({ status: 0, errors: ['Filter name is required'] });
  }

  // Validate regex patterns
  if (match_title_pattern) {
    try { new RegExp(match_title_pattern); } catch (e) {
      return res.status(400).json({ status: 0, errors: ['Invalid title pattern regex'] });
    }
  }
  if (match_message_pattern) {
    try { new RegExp(match_message_pattern); } catch (e) {
      return res.status(400).json({ status: 0, errors: ['Invalid message pattern regex'] });
    }
  }

  const filterId = uuidv4();
  db.run(
    `INSERT INTO filters (id, user_id, name, match_app_token, match_title_pattern, match_message_pattern,
     match_priority_min, match_priority_max, action, action_webhook_url, action_override_priority,
     action_override_sound, action_suppress, action_auto_acknowledge, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      filterId, req.dbUser.id, name,
      match_app_token || null, match_title_pattern || null, match_message_pattern || null,
      match_priority_min ?? null, match_priority_max ?? null,
      action, action_webhook_url || null,
      action_override_priority ?? null, action_override_sound || null,
      action_suppress ? 1 : 0, action_auto_acknowledge ? 1 : 0,
      sort_order,
    ]
  );

  const filter = db.get('SELECT * FROM filters WHERE id = ?', [filterId]);
  res.json({ status: 1, filter });
});

/**
 * PUT /api/v1/filters/:id
 * Update a filter.
 */
router.put('/:id', authenticateUser, (req, res) => {
  const filter = db.get(
    'SELECT * FROM filters WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!filter) {
    return res.status(404).json({ status: 0, errors: ['Filter not found'] });
  }

  const fields = [
    'name', 'is_active', 'match_app_token', 'match_title_pattern', 'match_message_pattern',
    'match_priority_min', 'match_priority_max', 'action', 'action_webhook_url',
    'action_override_priority', 'action_override_sound', 'action_suppress',
    'action_auto_acknowledge', 'sort_order',
  ];

  const updates = [];
  const params = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      const val = req.body[field];
      params.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(filter.id);
    db.run(`UPDATE filters SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const updated = db.get('SELECT * FROM filters WHERE id = ?', [filter.id]);
  res.json({ status: 1, filter: updated });
});

/**
 * DELETE /api/v1/filters/:id
 * Delete a filter.
 */
router.delete('/:id', authenticateUser, (req, res) => {
  db.run(
    'DELETE FROM filters WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );
  res.json({ status: 1 });
});

module.exports = router;
