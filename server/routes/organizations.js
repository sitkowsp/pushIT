const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../db/db');
const config = require('../config');
const { authenticateUser } = require('../middleware/auth');

/**
 * GET /api/v1/organizations
 * List all organizations the current user belongs to.
 */
router.get('/', authenticateUser, (req, res) => {
  const orgs = db.all(
    `SELECT o.*, om.role,
       (SELECT COUNT(*) FROM org_members WHERE organization_id = o.id) as member_count
     FROM organizations o
     JOIN org_members om ON o.id = om.organization_id
     WHERE om.user_id = ?
     ORDER BY o.name`,
    [req.dbUser.id]
  );

  res.json({ status: 1, organizations: orgs });
});

/**
 * POST /api/v1/organizations
 * Create a new organization. The creator becomes the owner.
 */
router.post('/', authenticateUser, (req, res) => {
  const { name } = req.body;

  if (!name || name.trim().length < 2) {
    return res.status(400).json({ status: 0, errors: ['Organization name must be at least 2 characters'] });
  }

  // Generate slug from name
  let slug = name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Ensure slug uniqueness
  let existingSlug = db.get('SELECT id FROM organizations WHERE slug = ?', [slug]);
  let suffix = 1;
  const baseSlug = slug;
  while (existingSlug) {
    slug = `${baseSlug}-${suffix++}`;
    existingSlug = db.get('SELECT id FROM organizations WHERE slug = ?', [slug]);
  }

  const orgId = uuidv4();

  db.run(
    'INSERT INTO organizations (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)',
    [orgId, name.trim(), slug, req.dbUser.id]
  );

  // Owner is automatically a member with 'owner' role
  db.run(
    'INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)',
    [orgId, req.dbUser.id, 'owner']
  );

  console.log(`[Orgs] Created organization: ${name} (${slug}) by ${req.dbUser.email}`);

  res.json({
    status: 1,
    organization: {
      id: orgId,
      name: name.trim(),
      slug,
      owner_user_id: req.dbUser.id,
      role: 'owner',
      member_count: 1,
    },
  });
});

/**
 * GET /api/v1/organizations/:id
 * Get organization details + members.
 * Only members can view.
 */
router.get('/:id', authenticateUser, (req, res) => {
  const membership = db.get(
    'SELECT * FROM org_members WHERE organization_id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!membership) {
    return res.status(404).json({ status: 0, errors: ['Organization not found'] });
  }

  const org = db.get('SELECT * FROM organizations WHERE id = ?', [req.params.id]);
  if (!org) {
    return res.status(404).json({ status: 0, errors: ['Organization not found'] });
  }

  const members = db.all(
    `SELECT u.id, u.email, u.display_name, om.role, om.joined_at
     FROM org_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.organization_id = ?
     ORDER BY om.role DESC, u.display_name`,
    [req.params.id]
  );

  // Get pending invites (only for owners/admins)
  let invites = [];
  if (membership.role === 'owner') {
    invites = db.all(
      `SELECT id, email, created_at, expires_at FROM org_invites
       WHERE organization_id = ? AND accepted_at IS NULL AND expires_at > datetime('now')
       ORDER BY created_at DESC`,
      [req.params.id]
    );
  }

  // Get org-scoped applications
  const apps = db.all(
    'SELECT id, name, icon_url, description, color, is_active FROM applications WHERE organization_id = ?',
    [req.params.id]
  );

  res.json({
    status: 1,
    organization: {
      ...org,
      role: membership.role,
      members,
      invites,
      applications: apps,
    },
  });
});

/**
 * PUT /api/v1/organizations/:id
 * Update organization details. Owner only.
 */
router.put('/:id', authenticateUser, (req, res) => {
  const membership = db.get(
    "SELECT * FROM org_members WHERE organization_id = ? AND user_id = ? AND role = 'owner'",
    [req.params.id, req.dbUser.id]
  );

  if (!membership) {
    return res.status(403).json({ status: 0, errors: ['Only the owner can update the organization'] });
  }

  const { name } = req.body;
  if (name && name.trim().length >= 2) {
    db.run('UPDATE organizations SET name = ? WHERE id = ?', [name.trim(), req.params.id]);
  }

  res.json({ status: 1 });
});

/**
 * POST /api/v1/organizations/:id/invite
 * Send an invite to join the organization.
 * Owner only. Creates a time-limited invite token.
 */
router.post('/:id/invite', authenticateUser, async (req, res) => {
  const membership = db.get(
    "SELECT * FROM org_members WHERE organization_id = ? AND user_id = ? AND role = 'owner'",
    [req.params.id, req.dbUser.id]
  );

  if (!membership) {
    return res.status(403).json({ status: 0, errors: ['Only the owner can send invites'] });
  }

  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ status: 0, errors: ['A valid email address is required'] });
  }

  // Check if already a member
  const existingUser = db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existingUser) {
    const alreadyMember = db.get(
      'SELECT 1 FROM org_members WHERE organization_id = ? AND user_id = ?',
      [req.params.id, existingUser.id]
    );
    if (alreadyMember) {
      return res.status(409).json({ status: 0, errors: ['This user is already a member'] });
    }
  }

  // Check for existing pending invite
  const existingInvite = db.get(
    `SELECT id FROM org_invites WHERE organization_id = ? AND email = ? AND accepted_at IS NULL AND expires_at > datetime('now')`,
    [req.params.id, email.toLowerCase()]
  );
  if (existingInvite) {
    return res.status(409).json({ status: 0, errors: ['An invite has already been sent to this email'] });
  }

  const inviteId = uuidv4();
  const token = crypto.randomBytes(32).toString('hex');

  // Invite expires in 7 days
  db.run(
    `INSERT INTO org_invites (id, organization_id, email, token, invited_by, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', '+7 days'))`,
    [inviteId, req.params.id, email.toLowerCase(), token, req.dbUser.id]
  );

  const org = db.get('SELECT name FROM organizations WHERE id = ?', [req.params.id]);

  // Send invite email if SMTP configured
  let inviteUrl;
  if (existingUser) {
    // Existing user — they just need to accept
    inviteUrl = `${config.baseUrl}/#accept-invite?token=${token}`;
  } else {
    // New user — they need to register via invite
    inviteUrl = `${config.baseUrl}/#register-invite?token=${token}`;
  }

  if (config.smtp.configured) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
      });

      await transporter.sendMail({
        from: config.smtp.from,
        to: email.toLowerCase(),
        subject: `pushIT — You've been invited to join ${org.name}`,
        text: `${req.dbUser.display_name} invited you to join "${org.name}" on pushIT.\n\nAccept the invite: ${inviteUrl}\n\nThis link expires in 7 days.`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
            <h2>You're invited!</h2>
            <p><strong>${req.dbUser.display_name}</strong> invited you to join <strong>${org.name}</strong> on pushIT.</p>
            <p><a href="${inviteUrl}" style="display:inline-block;padding:12px 24px;background:#e94560;color:#fff;text-decoration:none;border-radius:6px;">Accept Invite</a></p>
            <p style="color:#666;font-size:13px;">This link expires in 7 days.</p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.warn('[Orgs] Failed to send invite email:', emailErr.message);
    }
  }

  console.log(`[Orgs] Invite sent: ${email} → ${org.name} (token=${token.substring(0, 8)}...)`);

  res.json({
    status: 1,
    invite: {
      id: inviteId,
      email: email.toLowerCase(),
      invite_url: inviteUrl,
      expires_in: '7 days',
    },
  });
});

/**
 * POST /api/v1/organizations/accept-invite/:token
 * Accept an organization invite (for existing users).
 */
router.post('/accept-invite/:token', authenticateUser, (req, res) => {
  const invite = db.get(
    `SELECT * FROM org_invites WHERE token = ? AND accepted_at IS NULL AND expires_at > datetime('now')`,
    [req.params.token]
  );

  if (!invite) {
    return res.status(400).json({ status: 0, errors: ['Invalid or expired invite'] });
  }

  // Verify email matches
  if (invite.email.toLowerCase() !== req.dbUser.email.toLowerCase()) {
    return res.status(403).json({ status: 0, errors: ['This invite was sent to a different email address'] });
  }

  // Add to organization
  const alreadyMember = db.get(
    'SELECT 1 FROM org_members WHERE organization_id = ? AND user_id = ?',
    [invite.organization_id, req.dbUser.id]
  );

  if (!alreadyMember) {
    db.run(
      'INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)',
      [invite.organization_id, req.dbUser.id, 'member']
    );
  }

  db.run(`UPDATE org_invites SET accepted_at = datetime('now') WHERE id = ?`, [invite.id]);

  const org = db.get('SELECT * FROM organizations WHERE id = ?', [invite.organization_id]);
  console.log(`[Orgs] Invite accepted: ${req.dbUser.email} → ${org.name}`);

  res.json({ status: 1, organization: { id: org.id, name: org.name, slug: org.slug } });
});

/**
 * DELETE /api/v1/organizations/:id/members/:userId
 * Remove a member from the organization. Owner only.
 * Owner cannot remove themselves.
 */
router.delete('/:id/members/:userId', authenticateUser, (req, res) => {
  const membership = db.get(
    "SELECT * FROM org_members WHERE organization_id = ? AND user_id = ? AND role = 'owner'",
    [req.params.id, req.dbUser.id]
  );

  if (!membership) {
    return res.status(403).json({ status: 0, errors: ['Only the owner can remove members'] });
  }

  if (req.params.userId === req.dbUser.id) {
    return res.status(400).json({ status: 0, errors: ['Owner cannot remove themselves'] });
  }

  db.run(
    'DELETE FROM org_members WHERE organization_id = ? AND user_id = ?',
    [req.params.id, req.params.userId]
  );

  res.json({ status: 1 });
});

/**
 * DELETE /api/v1/organizations/:id
 * Delete an organization. Owner only.
 * Also removes all members and invites, and unlinks apps.
 */
router.delete('/:id', authenticateUser, (req, res) => {
  const org = db.get('SELECT * FROM organizations WHERE id = ? AND owner_user_id = ?', [req.params.id, req.dbUser.id]);

  if (!org) {
    return res.status(404).json({ status: 0, errors: ['Organization not found or not owned by you'] });
  }

  // Unlink applications
  db.run('UPDATE applications SET organization_id = NULL WHERE organization_id = ?', [req.params.id]);

  // Delete org (cascades to members and invites)
  db.run('DELETE FROM organizations WHERE id = ?', [req.params.id]);

  console.log(`[Orgs] Organization deleted: ${org.name} by ${req.dbUser.email}`);
  res.json({ status: 1 });
});

/**
 * PUT /api/v1/applications/:id/org
 * Link or unlink an application to an organization.
 * Only the app owner who is also an org member can do this.
 */
router.put('/apps/:appId/org', authenticateUser, (req, res) => {
  const { organization_id } = req.body;

  const app = db.get('SELECT * FROM applications WHERE id = ? AND user_id = ?', [req.params.appId, req.dbUser.id]);
  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found'] });
  }

  if (organization_id) {
    // Verify user is a member of the target organization
    const membership = db.get(
      'SELECT 1 FROM org_members WHERE organization_id = ? AND user_id = ?',
      [organization_id, req.dbUser.id]
    );
    if (!membership) {
      return res.status(403).json({ status: 0, errors: ['You are not a member of this organization'] });
    }
  }

  db.run('UPDATE applications SET organization_id = ? WHERE id = ?', [organization_id || null, req.params.appId]);
  res.json({ status: 1 });
});

module.exports = router;
