const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../db/db');
const config = require('../config');
const { authenticateUser } = require('../middleware/auth');
const { getSmtpConfig } = require('../services/smtp-config');

// HTML-escape for safe interpolation into email HTML templates
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

  // Get pending invites (only for owners/admins) — include token for invite URL
  let invites = [];
  if (membership.role === 'owner') {
    invites = db.all(
      `SELECT id, email, token, created_at, expires_at FROM org_invites
       WHERE organization_id = ? AND accepted_at IS NULL AND expires_at > datetime('now')
       ORDER BY created_at DESC`,
      [req.params.id]
    );
    // Compute invite URLs
    invites = invites.map((inv) => {
      const existingUser = db.get('SELECT id FROM users WHERE email = ?', [inv.email]);
      return {
        ...inv,
        invite_url: existingUser
          ? `${config.baseUrl}/#accept-invite?token=${inv.token}`
          : `${config.baseUrl}/#register-invite?token=${inv.token}`,
      };
    });
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

  const smtpConfig = getSmtpConfig();
  if (smtpConfig) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        auth: { user: smtpConfig.user, pass: smtpConfig.pass },
      });

      await transporter.sendMail({
        from: smtpConfig.from,
        to: email.toLowerCase(),
        subject: `pushIT — You've been invited to join ${org.name}`,
        text: `${req.dbUser.display_name} invited you to join "${org.name}" on pushIT.\n\nAccept the invite: ${inviteUrl}\n\nThis link expires in 7 days.`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
            <h2>You're invited!</h2>
            <p><strong>${escHtml(req.dbUser.display_name)}</strong> invited you to join <strong>${escHtml(org.name)}</strong> on pushIT.</p>
            <p><a href="${escHtml(inviteUrl)}" style="display:inline-block;padding:12px 24px;background:#e94560;color:#fff;text-decoration:none;border-radius:6px;">Accept Invite</a></p>
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
 * DELETE /api/v1/organizations/:id/invites/:inviteId
 * Delete (revoke) a pending invite. Owner only.
 */
router.delete('/:id/invites/:inviteId', authenticateUser, (req, res) => {
  const membership = db.get(
    "SELECT * FROM org_members WHERE organization_id = ? AND user_id = ? AND role = 'owner'",
    [req.params.id, req.dbUser.id]
  );
  if (!membership) {
    return res.status(403).json({ status: 0, errors: ['Only the owner can manage invites'] });
  }

  const invite = db.get(
    'SELECT * FROM org_invites WHERE id = ? AND organization_id = ?',
    [req.params.inviteId, req.params.id]
  );
  if (!invite) {
    return res.status(404).json({ status: 0, errors: ['Invite not found'] });
  }

  db.run('DELETE FROM org_invites WHERE id = ?', [req.params.inviteId]);
  console.log(`[Orgs] Invite deleted: ${invite.email} from org ${req.params.id}`);
  res.json({ status: 1 });
});

/**
 * POST /api/v1/organizations/:id/invites/:inviteId/resend
 * Re-send an invite email. Owner only. Requires SMTP.
 */
router.post('/:id/invites/:inviteId/resend', authenticateUser, async (req, res) => {
  const membership = db.get(
    "SELECT * FROM org_members WHERE organization_id = ? AND user_id = ? AND role = 'owner'",
    [req.params.id, req.dbUser.id]
  );
  if (!membership) {
    return res.status(403).json({ status: 0, errors: ['Only the owner can resend invites'] });
  }

  const invite = db.get(
    `SELECT * FROM org_invites WHERE id = ? AND organization_id = ? AND accepted_at IS NULL AND expires_at > datetime('now')`,
    [req.params.inviteId, req.params.id]
  );
  if (!invite) {
    return res.status(404).json({ status: 0, errors: ['Invite not found or expired'] });
  }

  const smtpConfig = getSmtpConfig();
  if (!smtpConfig) {
    return res.status(400).json({ status: 0, errors: ['SMTP is not configured'] });
  }

  const org = db.get('SELECT name FROM organizations WHERE id = ?', [req.params.id]);
  const existingUser = db.get('SELECT id FROM users WHERE email = ?', [invite.email]);

  const inviteUrl = existingUser
    ? `${config.baseUrl}/#accept-invite?token=${invite.token}`
    : `${config.baseUrl}/#register-invite?token=${invite.token}`;

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: { user: smtpConfig.user, pass: smtpConfig.pass },
    });

    await transporter.sendMail({
      from: smtpConfig.from,
      to: invite.email,
      subject: `pushIT — Reminder: You've been invited to join ${org.name}`,
      text: `${req.dbUser.display_name} reminded you about your invite to join "${org.name}" on pushIT.\n\nAccept the invite: ${inviteUrl}\n\nThis link expires ${new Date(invite.expires_at).toLocaleDateString()}.`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
          <h2>Reminder: You're invited!</h2>
          <p><strong>${escHtml(req.dbUser.display_name)}</strong> reminded you about your invite to join <strong>${escHtml(org.name)}</strong> on pushIT.</p>
          <p><a href="${escHtml(inviteUrl)}" style="display:inline-block;padding:12px 24px;background:#e94560;color:#fff;text-decoration:none;border-radius:6px;">Accept Invite</a></p>
          <p style="color:#666;font-size:13px;">This link expires ${new Date(invite.expires_at).toLocaleDateString()}.</p>
        </div>
      `,
    });

    console.log(`[Orgs] Invite resent to ${invite.email} for org ${org.name}`);
    res.json({ status: 1 });
  } catch (emailErr) {
    console.error('[Orgs] Failed to resend invite email:', emailErr.message);
    res.status(500).json({ status: 0, errors: ['Failed to send email: ' + emailErr.message] });
  }
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
