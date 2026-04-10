const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../db/db');
const { authenticateUser, generateUserKey } = require('../middleware/auth');

/**
 * GET /api/v1/groups
 * List groups the authenticated user owns or belongs to.
 */
router.get('/', authenticateUser, (req, res) => {
  const owned = db.all('SELECT * FROM groups WHERE owner_id = ?', [req.dbUser.id]);
  const memberOf = db.all(
    `SELECT g.* FROM groups g
     JOIN group_members gm ON g.id = gm.group_id
     WHERE gm.user_id = ? AND g.owner_id != ?`,
    [req.dbUser.id, req.dbUser.id]
  );

  res.json({
    status: 1,
    owned: owned.map(formatGroup),
    member_of: memberOf.map(formatGroup),
  });
});

/**
 * POST /api/v1/groups
 * Create a new group.
 */
router.post('/', authenticateUser, (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ status: 0, errors: ['Group name is required'] });
  }

  const groupId = uuidv4();
  const groupKey = generateUserKey();

  db.run(
    'INSERT INTO groups (id, name, group_key, owner_id) VALUES (?, ?, ?, ?)',
    [groupId, name, groupKey, req.dbUser.id]
  );

  // Add owner as a member
  db.run(
    'INSERT INTO group_members (group_id, user_id) VALUES (?, ?)',
    [groupId, req.dbUser.id]
  );

  res.json({
    status: 1,
    group: { id: groupId, name, group_key: groupKey },
  });
});

/**
 * POST /api/v1/groups/:id/members
 * Add a member to a group.
 */
router.post('/:id/members', authenticateUser, (req, res) => {
  const { user_key, device_name } = req.body;

  const group = db.get(
    'SELECT * FROM groups WHERE id = ? AND owner_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!group) {
    return res.status(404).json({ status: 0, errors: ['Group not found or not owned by you'] });
  }

  const user = db.get('SELECT * FROM users WHERE user_key = ?', [user_key]);
  if (!user) {
    return res.status(400).json({ status: 0, errors: ['User not found'] });
  }

  // Check if already a member
  const existing = db.get(
    'SELECT * FROM group_members WHERE group_id = ? AND user_id = ?',
    [group.id, user.id]
  );

  if (existing) {
    return res.status(400).json({ status: 0, errors: ['User is already a member'] });
  }

  db.run(
    'INSERT INTO group_members (group_id, user_id, device_name) VALUES (?, ?, ?)',
    [group.id, user.id, device_name || null]
  );

  res.json({ status: 1 });
});

/**
 * DELETE /api/v1/groups/:id/members/:userId
 * Remove a member from a group.
 */
router.delete('/:id/members/:userId', authenticateUser, (req, res) => {
  const group = db.get(
    'SELECT * FROM groups WHERE id = ? AND owner_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!group) {
    return res.status(404).json({ status: 0, errors: ['Group not found or not owned by you'] });
  }

  db.run(
    'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
    [group.id, req.params.userId]
  );

  res.json({ status: 1 });
});

function formatGroup(g) {
  return { id: g.id, name: g.name, group_key: g.group_key, created_at: g.created_at };
}

module.exports = router;
