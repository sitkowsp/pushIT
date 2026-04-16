const config = require('../config');
const db = require('../db/db');
const jwt = require('jsonwebtoken');

const SESSION_COOKIE = 'pushit_session';

/**
 * pushIT Authentication Middleware
 *
 * Multi-strategy approach — tries each method in order:
 *
 *   Strategy 0: Session cookie (self-signed JWT from our OAuth2 callback)
 *               This is the PRIMARY flow. User authenticates via
 *               /api/v1/auth/login → Azure AD → /api/v1/auth/callback
 *               and gets an httpOnly cookie with their identity.
 *
 *   Strategy 1: Custom SSO headers (Header-based SSO in Azure Portal)
 *               Reads configurable headers set via .env / proxyHeaders config.
 *
 *   Strategy 2: Standard Application Proxy headers
 *               X-MS-CLIENT-PRINCIPAL-NAME, X-MS-CLIENT-PRINCIPAL-ID
 *
 *   Strategy 3: Token passthrough header
 *               X-MS-TOKEN-AAD-ID-TOKEN — decoded without verification
 *               (trusted proxy infrastructure).
 *
 *   Strategy 4: Bearer JWT (backward compat / desktop MSAL fallback)
 */
function authenticateUser(req, res, next) {
  // ─── Strategy 0: Session cookie (primary auth method) ──────────────
  // Works for both Entra ID sessions and local email/password sessions.
  const sessionCookie = req.cookies && req.cookies[SESSION_COOKIE];
  if (sessionCookie) {
    try {
      const payload = jwt.verify(sessionCookie, config.session.secret);
      if (payload.email) {
        // Local auth sessions use userId + authType='local'
        if (payload.authType === 'local') {
          req.user = {
            entraObjectId: payload.userId,  // use userId as identifier
            email: payload.email,
            displayName: payload.displayName || payload.email.split('@')[0],
            authMethod: 'local-session',
          };
        } else {
          req.user = {
            entraObjectId: payload.entraObjectId || payload.email,
            email: payload.email,
            displayName: payload.displayName || payload.email.split('@')[0],
            tenantId: payload.tenantId,
            authMethod: 'session-cookie',
          };
        }
        return findOrCreateUser(req, res, next);
      }
    } catch (e) {
      // Cookie invalid or expired — fall through to other strategies
      console.warn('[Auth] Session cookie invalid:', e.message);
    }
  }

  // ─── Strategies 1-3: Proxy header auth (Entra mode only) ───────────
  // These strategies trust HTTP headers set by a reverse proxy (App Proxy).
  // In local auth mode, proxy headers are DISABLED to prevent spoofing —
  // without a trusted proxy stripping these headers, any client can set them.
  if (config.authMode === 'entra') {

  // ─── Strategy 1: Custom SSO headers (configurable) ─────────────────
  const hdr = config.proxyHeaders;
  const ssoEmail = req.headers[hdr.email];
  const ssoName  = req.headers[hdr.displayName];
  const ssoOid   = req.headers[hdr.objectId];
  const ssoUpn   = req.headers[hdr.upn];

  if (ssoEmail || ssoUpn) {
    const email = ssoEmail || ssoUpn;
    req.user = {
      entraObjectId: ssoOid || email,
      email: email,
      displayName: ssoName || email.split('@')[0],
      authMethod: 'proxy-sso-header',
    };
    return findOrCreateUser(req, res, next);
  }

  // ─── Strategy 2: Standard Application Proxy headers ────────────────
  const principalName = req.headers['x-ms-client-principal-name'];
  const principalId   = req.headers['x-ms-client-principal-id'];

  if (principalName) {
    let displayName = principalName.split('@')[0];
    let email = principalName;

    const principalB64 = req.headers['x-ms-client-principal'];
    if (principalB64) {
      try {
        const principal = JSON.parse(Buffer.from(principalB64, 'base64').toString());
        if (principal.claims) {
          for (const claim of principal.claims) {
            if (claim.typ === 'name' || claim.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') {
              displayName = claim.val;
            }
            if (claim.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress') {
              email = claim.val;
            }
            if (claim.typ === 'preferred_username') {
              email = claim.val;
            }
          }
        }
      } catch (e) {
        console.warn('[Auth] Failed to parse X-MS-CLIENT-PRINCIPAL:', e.message);
      }
    }

    req.user = {
      entraObjectId: principalId || principalName,
      email,
      displayName,
      authMethod: 'proxy-principal',
    };
    return findOrCreateUser(req, res, next);
  }

  // ─── Strategy 3: Token passthrough (X-MS-TOKEN-AAD-ID-TOKEN) ───────
  // Application Proxy can forward the id_token in this header.
  // We decode WITHOUT verification — the proxy is trusted infrastructure.
  const passthroughToken = req.headers['x-ms-token-aad-id-token'];
  if (passthroughToken) {
    try {
      const parts = passthroughToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        req.user = {
          entraObjectId: payload.oid || payload.sub,
          email: payload.preferred_username || payload.email || payload.upn,
          displayName: payload.name || (payload.preferred_username || '').split('@')[0],
          tenantId: payload.tid,
          authMethod: 'proxy-token-passthrough',
        };
        if (req.user.email) {
          return findOrCreateUser(req, res, next);
        }
      }
    } catch (e) {
      console.warn('[Auth] Failed to decode X-MS-TOKEN-AAD-ID-TOKEN:', e.message);
    }
  }

  } // end entra-only proxy header strategies

  // ─── Strategy 4: Bearer JWT (MSAL / backward compat) ──────────────
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authenticateByJWT(req, res, next);
  }

  // ─── No identity found ────────────────────────────────────────────
  return res.status(401).json({
    status: 0,
    errors: ['Not authenticated. Ensure Application Proxy Header-based SSO is configured.'],
  });
}

/**
 * Authenticate via JWT token (Bearer header).
 * Used as fallback for desktop MSAL or future API clients.
 */
function authenticateByJWT(req, res, next) {
  const jwt = require('jsonwebtoken');
  const jwksRsa = require('jwks-rsa');

  const jwksClient = jwksRsa({
    jwksUri: config.azure.jwksUri,
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 600000,
  });

  function getSigningKey(header, callback) {
    jwksClient.getSigningKey(header.kid, (err, key) => {
      if (err) return callback(err);
      callback(null, key.getPublicKey());
    });
  }

  const token = req.headers.authorization.split(' ')[1];

  jwt.verify(
    token,
    getSigningKey,
    {
      audience: config.azure.clientId,
      issuer: [
        config.azure.issuer,
        `https://sts.windows.net/${config.azure.tenantId}/`,
      ],
      algorithms: ['RS256'],
    },
    (err, decoded) => {
      if (err) {
        console.error('[Auth] JWT verification failed:', err.message);
        try {
          const parts = token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
            console.error('[Auth] Token aud:', payload.aud, '| Expected:', config.azure.clientId);
            console.error('[Auth] Token iss:', payload.iss, '| Expected:', config.azure.issuer);
          }
        } catch (e) { /* ignore */ }
        return res.status(401).json({ status: 0, errors: ['Invalid or expired token'] });
      }

      req.user = {
        entraObjectId: decoded.oid || decoded.sub,
        email: decoded.preferred_username || decoded.email || decoded.upn,
        displayName: decoded.name || decoded.preferred_username || 'Unknown',
        tenantId: decoded.tid,
        authMethod: 'jwt',
      };

      findOrCreateUser(req, res, next);
    }
  );
}

/**
 * Look up or auto-create user in database.
 */
function findOrCreateUser(req, res, next) {
  let dbUser = null;

  // For local-session auth, look up by userId (stored in entraObjectId field of the session)
  if (req.user.authMethod === 'local-session') {
    dbUser = db.get('SELECT * FROM users WHERE id = ?', [req.user.entraObjectId]);
    if (!dbUser) {
      // Also try email as fallback
      dbUser = db.get('SELECT * FROM users WHERE email = ?', [req.user.email]);
    }
  } else {
    // Entra ID flow: look up by entra_object_id
    dbUser = db.get('SELECT * FROM users WHERE entra_object_id = ?', [req.user.entraObjectId]);

    // Also try by email if not found by object ID
    if (!dbUser && req.user.email) {
      dbUser = db.get('SELECT * FROM users WHERE email = ?', [req.user.email]);
      if (dbUser && !dbUser.entra_object_id && req.user.entraObjectId) {
        db.run('UPDATE users SET entra_object_id = ? WHERE id = ?', [req.user.entraObjectId, dbUser.id]);
      }
    }
  }

  if (!dbUser) {
    // Auto-create for Entra users (local users are created via /local-auth/register)
    if (req.user.authMethod === 'local-session') {
      return res.status(401).json({ status: 0, errors: ['User not found. Please register.'] });
    }

    const { v4: uuidv4 } = require('uuid');
    const userId = uuidv4();
    const userKey = generateUserKey();

    // First user ever becomes admin automatically (self-hosted app)
    const userCount = db.get('SELECT COUNT(*) as count FROM users');
    const isFirstUser = (!userCount || userCount.count === 0) ? 1 : 0;

    db.run(
      `INSERT INTO users (id, entra_object_id, email, display_name, user_key, auth_type, email_verified, is_admin, last_login)
       VALUES (?, ?, ?, ?, ?, 'entra', 1, ?, datetime('now'))`,
      [userId, req.user.entraObjectId, req.user.email, req.user.displayName, userKey, isFirstUser]
    );

    dbUser = db.get('SELECT * FROM users WHERE id = ?', [userId]);
    console.log(`[Auth] Created new user: ${req.user.email} (${userId}) via ${req.user.authMethod}${isFirstUser ? ' [ADMIN]' : ''}`);
  } else {
    db.run(
      `UPDATE users SET last_login = datetime('now'), display_name = ?, email = ? WHERE id = ?`,
      [req.user.displayName, req.user.email, dbUser.id]
    );
  }

  req.dbUser = dbUser;
  next();
}

/**
 * Middleware: Authenticate API request via application token.
 * Used by n8n and other external services to push messages.
 */
function authenticateApp(req, res, next) {
  const token = req.body.token || req.query.token;

  if (!token) {
    return res.status(401).json({ status: 0, errors: ['Missing application token'] });
  }

  const app = db.get(
    'SELECT a.*, u.id as owner_user_id FROM applications a JOIN users u ON a.user_id = u.id WHERE a.token = ? AND a.is_active = 1',
    [token]
  );

  if (!app) {
    return res.status(401).json({ status: 0, errors: ['Invalid application token'] });
  }

  req.appRecord = app;
  next();
}

/**
 * Middleware: Allow either user auth (proxy/Bearer) or app auth (token param).
 */
function authenticateAny(req, res, next) {
  // Check session cookie first
  if (req.cookies && req.cookies[SESSION_COOKIE]) {
    return authenticateUser(req, res, next);
  }

  // Check custom SSO headers
  const hdr = config.proxyHeaders;
  if (req.headers[hdr.email] || req.headers[hdr.upn]) {
    return authenticateUser(req, res, next);
  }

  // Check standard proxy headers
  if (req.headers['x-ms-client-principal-name']) {
    return authenticateUser(req, res, next);
  }

  // Check token passthrough
  if (req.headers['x-ms-token-aad-id-token']) {
    return authenticateUser(req, res, next);
  }

  // Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authenticateUser(req, res, next);
  }

  // App token
  const token = req.body.token || req.query.token;
  if (token) {
    return authenticateApp(req, res, next);
  }

  return res.status(401).json({ status: 0, errors: ['No authentication provided'] });
}

/**
 * Generate a random 30-character user/group key.
 */
function generateUserKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = '';
  const crypto = require('crypto');
  const bytes = crypto.randomBytes(30);
  for (let i = 0; i < 30; i++) {
    key += chars[bytes[i] % chars.length];
  }
  return key;
}

/**
 * Generate a random 30-character application token.
 */
function generateAppToken() {
  return generateUserKey();
}

module.exports = {
  authenticateUser,
  authenticateApp,
  authenticateAny,
  generateUserKey,
  generateAppToken,
};
