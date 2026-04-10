require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

  db: {
    path: process.env.DB_PATH || './data/pushit.db',
  },

  azure: {
    tenantId: process.env.AZURE_TENANT_ID || '',
    clientId: process.env.AZURE_CLIENT_ID || '',
    clientSecret: process.env.AZURE_CLIENT_SECRET || '',
    get authority() {
      return `https://login.microsoftonline.com/${config.azure.tenantId}`;
    },
    get jwksUri() {
      return `https://login.microsoftonline.com/${config.azure.tenantId}/discovery/v2.0/keys`;
    },
    get issuer() {
      return `https://login.microsoftonline.com/${config.azure.tenantId}/v2.0`;
    },
  },

  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    email: process.env.VAPID_EMAIL || 'mailto:admin@example.com',
  },

  n8n: {
    baseUrl: process.env.N8N_BASE_URL || 'https://n8n.example.com',
    webhookSecret: process.env.N8N_WEBHOOK_SECRET || '',
  },

  // Proxy SSO headers — configurable per deployment.
  // Application Proxy Header-based SSO injects user identity as HTTP headers.
  // Set these to match the claim→header mappings in Azure Portal.
  proxyHeaders: {
    email:       process.env.PROXY_HEADER_EMAIL       || 'x-user-email',
    displayName: process.env.PROXY_HEADER_DISPLAYNAME  || 'x-user-displayname',
    objectId:    process.env.PROXY_HEADER_OBJECTID     || 'x-user-objectid',
    upn:         process.env.PROXY_HEADER_UPN          || 'x-user-upn',
  },

  session: {
    secret: process.env.SESSION_SECRET || 'change-me-in-production',
  },

  emergency: {
    retryInterval: parseInt(process.env.EMERGENCY_RETRY_INTERVAL || '60', 10),
    maxDuration: parseInt(process.env.EMERGENCY_MAX_DURATION || '10800', 10),
  },

  // Priority levels (Pushover-compatible)
  priorities: {
    LOWEST: -2,    // No notification at all
    LOW: -1,       // No sound/vibration
    NORMAL: 0,     // Default
    HIGH: 1,       // Bypass quiet hours
    EMERGENCY: 2,  // Repeat until acknowledged
  },
};

module.exports = config;
