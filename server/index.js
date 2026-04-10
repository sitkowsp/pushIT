const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');

const config = require('./config');
const { initDatabase, close: closeDb } = require('./db/db');
const { initWebPush } = require('./services/push');
const { startRetryProcessor, stopRetryProcessor } = require('./services/emergency');

// Route imports
const authRoutes = require('./routes/auth');
const messagesRoutes = require('./routes/messages');
const devicesRoutes = require('./routes/devices');
const applicationsRoutes = require('./routes/applications');
const filtersRoutes = require('./routes/filters');
const groupsRoutes = require('./routes/groups');
const webhooksRoutes = require('./routes/webhooks');

const app = express();
const server = http.createServer(app);

// Trust the reverse proxy (1 hop).
// CRITICAL: without this, Express won't set secure cookies behind a proxy
// because it sees HTTP, not HTTPS. The proxy sends X-Forwarded-Proto: https.
app.set('trust proxy', 1);

// ─── Middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: [
        "'self'",
        `wss://${new URL(config.baseUrl).host}`,
      ],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(cors({
  origin: config.baseUrl,
  credentials: true,
}));

app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(cookieParser());
app.use(express.json({ limit: '6mb' })); // 5MB for attachments + overhead
app.use(express.urlencoded({ extended: true }));

// Rate limiting for API
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,    // 1 minute
  max: 120,                // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 0, errors: ['Too many requests, please try again later'] },
});

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,                 // 30 messages per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 0, errors: ['Message rate limit exceeded'] },
});

// ─── API Routes ─────────────────────────────────────────────────────
app.use('/api/v1/auth', apiLimiter, authRoutes);
app.use('/api/v1/messages', messageLimiter, messagesRoutes);
app.use('/api/v1/devices', apiLimiter, devicesRoutes);
app.use('/api/v1/applications', apiLimiter, applicationsRoutes);
app.use('/api/v1/filters', apiLimiter, filtersRoutes);
app.use('/api/v1/groups', apiLimiter, groupsRoutes);
app.use('/api/v1/webhooks', messageLimiter, webhooksRoutes);

// Validate user/group endpoint (Pushover-compatible)
app.post('/api/v1/users/validate', apiLimiter, (req, res) => {
  const { authenticateApp } = require('./middleware/auth');
  const db = require('./db/db');

  authenticateApp(req, res, () => {
    const { user, device } = req.body;
    if (!user) {
      return res.status(400).json({ status: 0, errors: ['user parameter is required'] });
    }

    const dbUser = db.get('SELECT * FROM users WHERE user_key = ?', [user]);
    if (!dbUser) {
      return res.json({ status: 0, errors: ['user key is invalid'] });
    }

    let devicesQuery = 'SELECT * FROM devices WHERE user_id = ? AND is_active = 1';
    const params = [dbUser.id];
    if (device) {
      devicesQuery += ' AND name = ?';
      params.push(device);
    }

    const devices = db.all(devicesQuery, params);

    if (devices.length === 0 && device) {
      return res.json({ status: 0, errors: ['device name is not valid'] });
    }

    res.json({
      status: 1,
      devices: devices.map((d) => d.name),
      group: 0,
    });
  });
});

// App usage/limits endpoint
app.get('/api/v1/apps/limits', apiLimiter, (req, res) => {
  const { authenticateApp } = require('./middleware/auth');
  authenticateApp(req, res, () => {
    res.json({
      status: 1,
      limit: 100000,  // Self-hosted, generous limit
      remaining: 100000 - (req.appRecord.monthly_message_count || 0),
      reset: Math.floor(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime() / 1000),
    });
  });
});

// ─── Version endpoint (for cache-busting / auto-refresh) ───────────
const pkgVersion = require('../package.json').version;
app.get('/api/v1/version', (req, res) => {
  res.json({ version: pkgVersion });
});

// ─── Static files (PWA) ─────────────────────────────────────────────
// Short cache for HTML (needs fresh version tags), longer for versioned assets
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: 0,  // No server-side caching — SW handles caching with network-first
  etag: true,
}));

// SPA fallback - serve index.html for all non-API routes
// API 404 handler
app.use('/api', (req, res) => {
  res.status(404).json({ status: 0, errors: ['Endpoint not found'] });
});

// SPA fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── WebSocket server ───────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Map(); // userId -> Set<ws>

wss.on('connection', (ws, req) => {
  let userId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'auth' && msg.userId) {
        userId = msg.userId;
        if (!wsClients.has(userId)) {
          wsClients.set(userId, new Set());
        }
        wsClients.get(userId).add(ws);
        ws.send(JSON.stringify({ type: 'auth_ok' }));
      }
    } catch (e) {
      // Ignore invalid messages
    }
  });

  ws.on('close', () => {
    if (userId && wsClients.has(userId)) {
      wsClients.get(userId).delete(ws);
      if (wsClients.get(userId).size === 0) {
        wsClients.delete(userId);
      }
    }
  });

  ws.on('error', () => {
    // Clean up on error
    if (userId && wsClients.has(userId)) {
      wsClients.get(userId).delete(ws);
    }
  });
});

// Export for use in push service (send real-time updates via WS)
app.locals.wsClients = wsClients;
app.locals.wsBroadcastToUser = (userId, data) => {
  const clients = wsClients.get(userId);
  if (clients) {
    const payload = JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === 1) { // OPEN
        ws.send(payload);
      }
    }
  }
};

// ─── Error handling ─────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ status: 0, errors: ['Internal server error'] });
});

// ─── Startup ────────────────────────────────────────────────────────
async function start() {
  try {
    // Initialize database
    await initDatabase();

    // Initialize Web Push
    initWebPush();

    // Start emergency retry processor
    startRetryProcessor();

    // Start HTTP server
    server.listen(config.port, () => {
      console.log(`\n  🚀 pushIT server running`);
      console.log(`  📍 ${config.baseUrl}`);
      console.log(`  🔧 Environment: ${config.nodeEnv}`);
      console.log(`  📱 VAPID: ${config.vapid.publicKey ? 'configured' : 'NOT configured (run npm run vapid:generate)'}`);
      console.log(`  🔐 Azure: ${config.azure.clientId ? 'configured' : 'NOT configured'}`);
      console.log('');
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  stopRetryProcessor();
  closeDb();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  stopRetryProcessor();
  closeDb();
  server.close(() => process.exit(0));
});

start();

module.exports = app;
