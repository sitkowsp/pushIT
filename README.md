# pushIT

> **v1.11.0** — Self-hosted push notification service with a PWA client, flexible authentication (Microsoft Entra ID or local email/password), and n8n integration. Similar to [Pushover](https://pushover.net) but fully self-hosted.

## Features

- **PWA for iOS & Android** — installable from the browser, works like a native app
- **Web Push** — real-time push notifications via VAPID/Web Push API (iOS 16.4+)
- **Dual auth mode** — Microsoft Entra ID (work account) or local email/password registration; auto-detected from config
- **Organizations** — create orgs, invite friends by email, scope apps to an organization
- **Pushover-compatible API** — simple REST API for pushing notifications from any HTTP client
- **n8n integration** — bidirectional webhooks (receive from n8n, forward to n8n)
- **Priority system** — -2 (silent) to 2 (emergency with retry until acknowledged)
- **Notification filters** — route, modify, suppress, or forward notifications by pattern
- **Device management** — rename or delete registered devices from Settings; multiple devices with the same browser/OS are auto-suffixed (e.g., `windows-chrome-2`) so each one keeps its own push subscription
- **Groups** — send to multiple users at once
- **Custom icons & images** — per-notification icon and large preview image (Android/Windows/macOS)
- **SQLite** — zero-maintenance database, single-file backup
- **Real-time** — WebSocket for instant message delivery to open clients (cookie-authenticated)
- **Protocol-aware** — `BASE_URL` determines HTTPS behavior (secure cookies, CSP, HSTS, `wss://` vs `ws://`)
- **Security** — CSRF protection, WebSocket cookie auth, token leak prevention, query parameter bounds validation

## Architecture

```
[n8n / scripts / apps]
        │
        ▼ POST /api/v1/messages
┌─────────────────────┐      ┌──────────────────┐
│  pushIT Server      │◄────►│  SQLite Database  │
│  (Node.js/Express)  │      └──────────────────┘
│  Port 3000          │
└────────┬────────────┘
         │ Web Push (VAPID)
         ▼
┌─────────────────────┐
│  PWA Client         │
│  (iOS / Android /   │
│   Desktop browser)  │
└─────────────────────┘
```

## Requirements

- **App Server**: Ubuntu 22.04+, Node.js 20+, 512MB RAM minimum
- **Reverse Proxy**: Apache2 with mod_proxy, mod_proxy_wstunnel, SSL (or nginx)
- **Azure** (optional): Entra ID (Azure AD) App Registration — only needed for `AUTH_MODE=azure`
- **iOS**: 16.4+ for Web Push support

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/pushit.git
cd pushit
npm install --omit=dev
```

### 2. Configure

```bash
cp .env.example .env
nano .env
```

Run `npm run vapid:generate` to create VAPID keys, then configure authentication:

**Azure (Entra ID) mode** — set `AUTH_MODE=azure` (or just provide `AZURE_TENANT_ID` and friends):

```
AUTH_MODE=azure
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
```

**Local (email/password) mode** — set `AUTH_MODE=local` (auto-detected if no `AZURE_TENANT_ID`):

```
AUTH_MODE=local
REGISTRATION_OPEN=true          # allow anyone to register (default: true)
SMTP_HOST=smtp.example.com      # optional — needed for org invite emails
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=pushit@example.com
```

### 3. Start

```bash
npm start
```

The server starts on port 3000. Set up a reverse proxy (Apache2 or nginx) to handle SSL termination.

## Production Deployment

For a full production setup on Ubuntu, use the deployment script:

```bash
# Build the package
bash deploy/build-package.sh

# Copy to server and deploy
scp pushit-*.tar.gz user@your-server:/tmp/
ssh user@your-server
cd /tmp && tar -xzf pushit-*.tar.gz && cd pushit-*
sudo bash deploy/deploy.sh
```

The script installs Node.js, creates a system user, generates VAPID keys and secrets, initializes the database, and starts a systemd service.

During setup the script prompts for:

- **Auth mode** — Entra ID (Y) or local email/password (N, the default)
- **SSL mode** — three options:
  1. **Let's Encrypt** — automatic certificate for a public domain
  2. **Self-signed** — generated certificate for LAN/IP access (auto-detects server IP)
  3. **Manual** — bring your own certificate files
- **Apache** — if Apache is not installed or you skip setup, the script sets `BASE_URL=http://IP:PORT` for plain HTTP

See `deploy/deploy.sh` for details.

### LAN / Local Network Deployment

pushIT works on a local network without a public domain. During deployment, choose option 2 ("Local network / LAN") to generate a self-signed SSL certificate for your server's IP address. The certificate uses `subjectAltName` so Chrome and Edge accept it.

To avoid browser warnings, import the generated certificate (`/etc/ssl/pushit/pushit.crt`) as a trusted root CA on client devices. Without HTTPS, service workers and push notifications will only work from `localhost`.

If you skip Apache setup entirely, the deploy script sets `BASE_URL=http://IP:3000` so the app works over plain HTTP — but push notifications will be limited to localhost access.

### Apache2 Reverse Proxy

The deploy script can configure Apache automatically. If you prefer manual setup, an example config is included at `deploy/apache2-pushit.conf`. It handles HTTPS termination, WebSocket proxying, and security headers. Edit the file and replace `YOUR_DOMAIN` and `BACKEND_IP` with your values.

> **Important for wildcard certs:** If your reverse proxy uses a wildcard certificate shared across multiple vhosts on the same IP, the config includes `Protocols http/1.1` to prevent HTTP/2 connection coalescing. Without this, iOS PWA users may see HTTP 421 "Misdirected Request" errors when opening external links. See the [iOS notes](#ios-notes) section below.

### Azure App Registration

1. Go to **Azure Portal** → **App Registrations** → Create new
2. **Platform**: Add "Web" with redirect URI `https://YOUR_DOMAIN/api/v1/auth/callback`
3. **API Permissions**: `openid`, `profile`, `email`, `User.Read`
4. **Client Secret**: Create one and add it to your `.env` as `AZURE_CLIENT_SECRET`

### First Login

1. Open `https://YOUR_DOMAIN` on your phone or desktop
2. Sign in with your Microsoft work account (azure mode) or register with email/password (local mode)
3. On iOS: tap Share → "Add to Home Screen" to install the PWA
4. Allow notifications when prompted
5. Go to Settings tab to see your User Key and API token

## API Usage

### Send a notification

```bash
curl -X POST https://YOUR_DOMAIN/api/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_APP_TOKEN",
    "user": "USER_KEY",
    "title": "Server Alert",
    "message": "CPU at 95% on prod-db-01",
    "priority": 1
  }'
```

### n8n webhook

```bash
curl -X POST https://YOUR_DOMAIN/api/v1/webhooks/n8n \
  -H "X-Webhook-Secret: YOUR_N8N_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "user": "USER_KEY",
    "title": "Workflow Complete",
    "message": "Data import finished: 1,234 records processed"
  }'
```

### Priority levels

| Priority | Name      | Behavior                                    |
|----------|-----------|---------------------------------------------|
| -2       | Lowest    | No notification shown, badge only           |
| -1       | Low       | No sound/vibration, silent popup            |
| 0        | Normal    | Default sound and alert                     |
| 1        | High      | Bypasses quiet hours, always sounds         |
| 2        | Emergency | Repeats until acknowledged (requires retry/expire) |

See [API-MANUAL.md](API-MANUAL.md) for the full API reference with all parameters, examples in curl, Python, PowerShell, and n8n.

## Using the App

pushIT has four main tabs accessible from the bottom navigation bar. For the full guide with detailed instructions, see [USER-GUIDE.md](USER-GUIDE.md).

### Messages

Your notification inbox. All push notifications appear here in reverse chronological order. Each message card shows the title, body, timestamp, and sending app name with a colored indicator. Unread messages are visually highlighted — tap a card to mark it as read.

Message actions include: delete (x button), open linked URL (if the sender included one), and acknowledge (for emergency priority alerts that repeat until confirmed). If the notification includes an image, a preview is shown below the message text.

The toolbar at the top provides a delete-all button (trash icon) and a manual refresh button. Messages also arrive in real-time via WebSocket.

### Apps

Manage your notification sources. Each app has its own API token that you use in API calls, n8n workflows, or scripts. Tap the token field to copy it to your clipboard.

Create a new app with **+ New App** — give it a name, color, and choose Private (only you) or Public (any user can subscribe). For apps you own, you can edit, delete, or unsubscribe. Browse public apps from other users at the bottom of the list.

### Filters

Automatically route, modify, or suppress notifications based on regex patterns. Filters can match against notification titles and/or message bodies. Actions include forwarding to a webhook URL (for n8n integration) or suppressing the notification entirely. Use the toggle switch to enable/disable filters without deleting them.

### Settings

Shows your account info (name, email, User Key), push notification status, registered devices, and a built-in API quick reference. The API section has ready-to-use code examples in curl, Python, PowerShell, and n8n — all pre-filled with your User Key and server URL so you can copy and paste directly.

Tap **Enable Push Notifications** if push isn't active on your current device. The **Sign Out** button ends your session.

### Organizations

Users can create organizations (contexts) from the Settings tab to group people and apps together. The organization owner can invite members by email — invitees receive a link to join (email delivery requires SMTP settings; otherwise the invite link is shown in the UI). Apps can be scoped to an organization so that all members receive notifications from shared sources without needing individual subscriptions.

## iOS Notes

iOS web push has some platform limitations compared to Android/Windows/macOS:

- **Notifications**: Only `title` and `body` are supported. Custom `icon`, `image`, `badge`, and `actions` are silently ignored by Safari. The notification icon is always the PWA manifest icon.
- **External links**: In standalone PWA mode, links open inside SFSafariViewController (an in-app browser). If your reverse proxy uses a wildcard cert shared across vhosts, HTTP/2 connection coalescing can cause 421 errors. The included Apache config prevents this with `Protocols http/1.1`. The client also provides a modal fallback with "Open Link" and "Copy URL" options.
- **Images**: Always displayed in the pushIT web app message cards, even though iOS notifications don't show them.

## Maintenance

```bash
# Update code (preserves .env and database)
sudo bash /opt/pushit/deploy/update.sh

# Backup database
sudo bash /opt/pushit/deploy/backup.sh

# View logs
sudo journalctl -u pushit -f

# Service management
sudo systemctl status pushit
sudo systemctl restart pushit
```

Daily backup cron (3 AM):
```
0 3 * * * /opt/pushit/deploy/backup.sh >> /var/log/pushit-backup.log 2>&1
```

## File Structure

```
pushit/
├── server/                 # Backend (Express.js)
│   ├── index.js            # Entry point
│   ├── config.js           # Environment config
│   ├── routes/             # API endpoints
│   ├── services/           # Push, emergency, filters
│   ├── middleware/          # Auth (Entra ID + app tokens)
│   └── db/                 # SQLite schema + helpers
├── public/                 # PWA frontend
│   ├── index.html          # App shell
│   ├── sw.js               # Service worker
│   ├── manifest.json       # PWA manifest
│   ├── js/                 # Auth, push, UI modules
│   ├── css/                # Dark theme styles
│   └── icons/              # PWA icons
├── deploy/                 # Deployment scripts
│   ├── deploy.sh           # Full deployment
│   ├── update.sh           # Quick update
│   ├── backup.sh           # Database backup
│   ├── pushit.service      # systemd unit
│   └── apache2-pushit.conf # Reverse proxy config
├── scripts/                # Utilities (VAPID key generation)
├── data/                   # SQLite database (auto-created)
├── .env                    # Configuration (not in git)
├── .env.example            # Configuration template
├── API-MANUAL.md           # Full API reference
├── USER-GUIDE.md           # App interface guide
└── SETUP-SSO.md            # Header-based SSO guide
```

## License

MIT
