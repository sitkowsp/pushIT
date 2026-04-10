# pushIT API Manual

## Authentication

All message-sending endpoints authenticate via **app token**. Include your token in the request body as the `token` field, or as a `Bearer` token in the `Authorization` header.

User-facing endpoints (reading messages, managing apps/filters) authenticate via **session cookie** (set by the OAuth2 login flow).

Get your app token from the **Apps** tab in the pushIT web interface.

## Base URL

```
https://push.example.com
```

---

## Send Notification

**POST** `/api/v1/messages`

Send a push notification to a specific user, a group, or broadcast to all app subscribers.

### Send to a specific user

```json
POST /api/v1/messages
Content-Type: application/json

{
  "token": "YOUR_APP_TOKEN",
  "user": "USER_KEY",
  "title": "Backup Complete",
  "message": "Server backup finished successfully at 3:00 AM",
  "priority": 0
}
```

### Broadcast to all subscribers

Omit the `user` field to send to everyone subscribed to your app:

```json
POST /api/v1/messages
Content-Type: application/json

{
  "token": "YOUR_APP_TOKEN",
  "title": "System Maintenance",
  "message": "Scheduled maintenance window starts in 30 minutes",
  "priority": 1
}
```

### Send to a group

Pass a group key as the `user` value:

```json
{
  "token": "YOUR_APP_TOKEN",
  "user": "GROUP_KEY",
  "title": "Team Alert",
  "message": "Deploy complete"
}
```

### Send to multiple users

Pass comma-separated user keys (max 50):

```json
{
  "token": "YOUR_APP_TOKEN",
  "user": "USER_KEY_1,USER_KEY_2,USER_KEY_3",
  "title": "Alert",
  "message": "Check the dashboard"
}
```

### Full request body parameters

| Parameter      | Type    | Required | Default       | Description                                          |
|----------------|---------|----------|---------------|------------------------------------------------------|
| `token`        | string  | Yes      | —             | Your application API token                           |
| `user`         | string  | No       | —             | User key, group key, or comma-separated user keys. Omit to broadcast to all subscribers |
| `message`      | string  | Yes      | —             | Notification body text                               |
| `title`        | string  | No       | App name      | Notification title                                   |
| `html`         | boolean | No       | false         | Set to `true` to render HTML in the message body     |
| `priority`     | integer | No       | 0             | -2 (lowest) to 2 (emergency). See priority levels    |
| `sound`        | string  | No       | "pushit"      | Notification sound name                              |
| `url`          | string  | No       | —             | URL to open when notification is tapped              |
| `url_title`    | string  | No       | "Open Link"   | Label for the URL button                             |
| `icon`         | string  | No       | App icon / pushIT default | HTTPS URL to a custom notification icon. See icon & image guidelines below |
| `image`        | string  | No       | —             | URL to a preview image displayed in the notification and message card. See icon & image guidelines below |
| `device`       | string  | No       | —             | Target a specific device name (sends to all devices if omitted) |
| `timestamp`    | integer | No       | Current time  | Unix timestamp for the notification                  |
| `ttl`          | integer | No       | —             | Time-to-live in seconds (message expires after this) |
| `tags`         | string  | No       | —             | Comma-separated tags for categorization              |
| `callback_url` | string  | No       | —             | URL to call when message is acknowledged (emergency only) |
| `retry`        | integer | Cond.    | —             | Retry interval in seconds (required for priority 2)  |
| `expire`       | integer | Cond.    | —             | Expiration in seconds (required for priority 2)      |

### Icon & image guidelines

pushIT notifications support two visual elements via the Web Push Notification API:

- **`icon`** — The app icon shown next to the notification title (left side). If omitted, falls back to the app's `icon_url` (set in app settings), then the default pushIT icon.
- **`image`** — A large preview image shown alongside or below the notification text. Also displayed in the pushIT web app message card.

#### Icon

| Property       | Recommendation                                         |
|----------------|--------------------------------------------------------|
| **Format**     | PNG (with transparency) or JPEG                        |
| **Dimensions** | **192×192 px** recommended (square). iOS/macOS may round corners automatically |
| **Max size**   | Under **100 KB**                                       |
| **URL**        | Must be a publicly accessible HTTPS URL                |

#### Image

| Property       | Recommendation                                         |
|----------------|--------------------------------------------------------|
| **Format**     | JPEG or PNG (JPEG preferred for photos, PNG for screenshots) |
| **Dimensions** | Up to **1350×900 px**. Displayed at max 200px height in the web app |
| **Max size**   | Under **1 MB** for fast loading. Under 500 KB ideal   |
| **URL**        | Must be a publicly accessible HTTPS URL                |

**Platform support:**

| Platform            | Custom icon | Notification image | In-app image |
|---------------------|-------------|--------------------|--------------|
| Android Chrome      | Yes         | Yes (large preview) | Yes          |
| Windows Chrome/Edge | Yes         | Yes (large preview) | Yes          |
| macOS Chrome/Safari | Yes         | Yes                | Yes          |
| iOS Safari PWA      | No*         | No*                | Yes          |

> \* **iOS limitation:** Safari web push only supports `title`, `body`, `tag`, and `requireInteraction`. Custom `icon`, `image`, `badge`, and `actions` are silently ignored. The notification icon is always the PWA manifest icon. Images are still displayed in the pushIT web app message cards on all platforms. This is an Apple platform restriction, not a pushIT limitation.

#### External links on iOS

When a notification includes a `url`, tapping "Open Link" opens the URL in the user's browser. On most platforms this works as expected. On **iOS Safari PWA (standalone mode)**, external links open inside an in-app browser (SFSafariViewController) which can cause HTTP 421 "Misdirected Request" errors when multiple vhosts share the same wildcard TLS certificate and IP address (HTTP/2 connection coalescing).

**Server-side fix:** The Apache config uses `Protocols http/1.1` on the pushIT VirtualHost to prevent HTTP/2 connection coalescing entirely. This is the primary fix — without it, SFSafariViewController reuses TLS connections across domains and Apache rejects the mismatched SNI.

**Client-side fallback:** On iOS standalone, pushIT first tries the `x-safari-https://` URL scheme (opens directly in Safari on supported iOS versions). If that doesn't work, a modal appears with "Open Link" and "Copy URL" options, so the user can always reach the external site.

This is transparent to the API caller — no changes needed on the sending side.

| Platform            | Link opens in                |
|---------------------|------------------------------|
| Android Chrome      | Default browser (new tab)    |
| Windows Chrome/Edge | Default browser (new tab)    |
| macOS Chrome/Safari | Default browser (new tab)    |
| iOS Safari PWA      | In-app browser or Safari     |

### Priority levels

| Value | Name      | Behavior                                                        |
|-------|-----------|-----------------------------------------------------------------|
| -2    | Lowest    | Silent notification, no sound or vibration                      |
| -1    | Low       | Quiet notification, no sound                                    |
|  0    | Normal    | Standard notification with sound                                |
|  1    | High      | High priority, re-notifies even if same tag exists              |
|  2    | Emergency | Repeated notifications until acknowledged (requires `retry` and `expire`). Shows "Acknowledge" button |

### Response

```json
{
  "status": 1,
  "request": "uuid-of-request"
}
```

For emergency priority, the response includes a receipt:

```json
{
  "status": 1,
  "request": "uuid-of-request",
  "receipt": "receipt-id"
}
```

When broadcasting with no subscribers:

```json
{
  "status": 1,
  "request": "uuid-of-request",
  "message": "No subscribers for this app"
}
```

---

## Get Messages

**GET** `/api/v1/messages`

Retrieve message history for the authenticated user. Requires session cookie authentication.

### Query parameters

| Parameter | Type    | Default | Description                     |
|-----------|---------|---------|---------------------------------|
| `limit`   | integer | 50      | Max messages to return          |
| `offset`  | integer | 0       | Pagination offset               |
| `unread`  | boolean | —       | Set to `1` to filter unread only |

### Response

```json
{
  "status": 1,
  "messages": [
    {
      "id": "uuid",
      "title": "Alert",
      "message": "Server rebooted",
      "html": 0,
      "priority": 1,
      "sound": "pushit",
      "url": "https://...",
      "url_title": "Open",
      "image": "https://example.com/screenshot.png",
      "app_name": "monitoring",
      "app_color": "#e94560",
      "receipt": null,
      "acknowledged": null,
      "is_read": 0,
      "timestamp": 1712000000,
      "created_at": "2026-04-09T12:00:00.000Z"
    }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

---

## Mark Message as Read / Unread

**POST** `/api/v1/messages/:id/read`
**POST** `/api/v1/messages/:id/unread`

Toggle the read state of a message. Requires session cookie authentication.

---

## Acknowledge Emergency Message

**POST** `/api/v1/messages/:id/acknowledge`

Acknowledge an emergency (priority 2) notification to stop retries. Requires session cookie authentication.

---

## Delete Messages

**DELETE** `/api/v1/messages/:id`

Delete a single message.

**DELETE** `/api/v1/messages`

Delete all messages for the authenticated user. Supports filtering by app name:

```
DELETE /api/v1/messages?app_name=monitoring
```

This deletes only messages from the specified app. Omit the query param to delete all.

---

## Check Emergency Receipt

**GET** `/api/v1/messages/receipts/:receipt`

Check whether an emergency notification has been acknowledged. Authenticates via app token.

```bash
curl -s https://push.example.com/api/v1/messages/receipts/RECEIPT_ID \
  -H "Authorization: Bearer YOUR_APP_TOKEN"
```

Response:

```json
{
  "status": 1,
  "acknowledged": 0,
  "acknowledged_at": 0,
  "acknowledged_by": null,
  "last_delivered_at": "2026-04-02T12:00:00.000Z",
  "expired": 0,
  "called_back": 0,
  "called_back_at": 0
}
```

---

## Applications

### List your applications

**GET** `/api/v1/applications`

Returns apps you own and public apps you're subscribed to. Each app includes:

- `message_count` — real-time count of messages from this app for the current user
- `subscriber_count` — number of users subscribed
- `is_subscribed` — whether the current user is subscribed
- `is_owner` — whether the current user owns the app
- `visibility` — `"private"` or `"public"`
- `color` — hex color string

### Create application

**POST** `/api/v1/applications`

```json
{
  "name": "monitoring",
  "description": "Infrastructure alerts",
  "visibility": "public",
  "color": "#ff6b35"
}
```

| Parameter     | Type   | Required | Default     | Description                    |
|---------------|--------|----------|-------------|--------------------------------|
| `name`        | string | Yes      | —           | Application name               |
| `description` | string | No       | —           | Short description              |
| `visibility`  | string | No       | "private"   | `"private"` or `"public"`      |
| `color`       | string | No       | "#e94560"   | Hex color for the app badge    |
| `icon_url`    | string | No       | —           | URL to app icon                |

The creator is automatically subscribed to their own app.

### Update application

**PUT** `/api/v1/applications/:id`

Updatable fields: `name`, `description`, `icon_url`, `is_active`, `visibility`, `color`.

### Delete application

**DELETE** `/api/v1/applications/:id`

### Regenerate token

**POST** `/api/v1/applications/:id/regenerate-token`

### Browse public apps

**GET** `/api/v1/applications/public`

Lists all public apps in the tenant with subscription status.

### Subscribe / Unsubscribe

**POST** `/api/v1/applications/:id/subscribe` — Subscribe to a public app.

**POST** `/api/v1/applications/:id/unsubscribe` — Unsubscribe from an app. Also deletes existing messages from that app for the user.

---

## Filters

Filters let users route, modify, or suppress notifications based on patterns.

### List filters

**GET** `/api/v1/filters`

### Create filter

**POST** `/api/v1/filters`

```json
{
  "name": "Critical to webhook",
  "match_title_pattern": "CRITICAL|ERROR",
  "match_message_pattern": "server down",
  "action": "forward",
  "action_webhook_url": "https://your-n8n.example.com/webhook/...",
  "action_suppress": false
}
```

### Update filter

**PUT** `/api/v1/filters/:id`

Updatable fields: `name`, `match_title_pattern`, `match_message_pattern`, `action`, `action_webhook_url`, `action_suppress`, `is_active`.

### Toggle filter

**PUT** `/api/v1/filters/:id`

```json
{ "is_active": true }
```

---

## Devices

### List devices

**GET** `/api/v1/devices`

Returns all registered devices for the current user with push status.

---

## n8n Webhook Endpoint

**POST** `/api/v1/webhooks/n8n`

Alternative endpoint for n8n. Authenticates via shared secret instead of app token.

```json
{
  "webhook_secret": "YOUR_N8N_WEBHOOK_SECRET",
  "user": "USER_KEY",
  "title": "n8n Alert",
  "message": "Workflow failed: Error in HTTP node"
}
```

Or pass the secret as a header: `X-Webhook-Secret: YOUR_N8N_WEBHOOK_SECRET`

---

## Version Check

**GET** `/api/v1/version`

Returns the current server version. Used by the client for auto-update detection.

```json
{ "version": "1.2.3" }
```

---

## Examples

### curl — simple notification

```bash
curl -s https://push.example.com/api/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_APP_TOKEN",
    "user": "USER_KEY",
    "title": "Hello",
    "message": "This is a test notification"
  }'
```

### curl — broadcast with URL button

```bash
curl -s https://push.example.com/api/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_APP_TOKEN",
    "title": "Build Complete",
    "message": "Frontend build #247 passed all tests",
    "url": "https://ci.example.com/builds/247",
    "url_title": "View Build",
    "priority": 1
  }'
```

### curl — with custom icon and image

```bash
curl -s https://push.example.com/api/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_APP_TOKEN",
    "user": "USER_KEY",
    "title": "Grafana Alert",
    "message": "CPU usage exceeded 90% for 5 minutes",
    "icon": "https://grafana.example.com/public/img/grafana_icon.png",
    "image": "https://grafana.example.com/render/dashboard/cpu?width=800&height=400",
    "url": "https://grafana.example.com/d/cpu",
    "url_title": "Open Dashboard",
    "priority": 1
  }'
```

### curl — emergency with acknowledgement

```bash
curl -s https://push.example.com/api/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_APP_TOKEN",
    "user": "USER_KEY",
    "title": "SERVER DOWN",
    "message": "Production server is not responding",
    "priority": 2,
    "retry": 60,
    "expire": 3600,
    "sound": "siren"
  }'
```

### curl — HTML notification

```bash
curl -s https://push.example.com/api/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_APP_TOKEN",
    "user": "USER_KEY",
    "title": "Report Ready",
    "message": "<b>Monthly report</b> is ready for <i>review</i>.",
    "html": true,
    "url": "https://reports.example.com/march",
    "url_title": "Open Report"
  }'
```

### n8n — HTTP Request node

Use the **HTTP Request** node in n8n with these settings:

| Setting          | Value                                      |
|------------------|--------------------------------------------|
| Method           | POST                                       |
| URL              | `https://push.example.com/api/v1/messages`   |
| Body Content Type| JSON                                       |
| Body             | (see below)                                |

```json
{
  "token": "YOUR_APP_TOKEN",
  "title": "Workflow Complete",
  "message": "{{ $json.summary }}",
  "url": "{{ $json.link }}",
  "url_title": "Open Details"
}
```

To broadcast to all subscribers, simply omit the `user` field.

### PowerShell

```powershell
$body = @{
    token   = "YOUR_APP_TOKEN"
    title   = "Deployment"
    message = "App deployed to production successfully"
    url     = "https://app.example.com"
    url_title = "Open App"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://push.example.com/api/v1/messages" `
  -Method POST -Body $body -ContentType "application/json"
```

### Python

```python
import requests

requests.post("https://push.example.com/api/v1/messages", json={
    "token": "YOUR_APP_TOKEN",
    "title": "Task Done",
    "message": "Data processing completed: 1,247 records updated",
    "priority": 1
})
```

### Python — with image

```python
import requests

requests.post("https://push.example.com/api/v1/messages", json={
    "token": "YOUR_APP_TOKEN",
    "user": "USER_KEY",
    "title": "Screenshot captured",
    "message": "New deployment screenshot",
    "image": "https://screenshots.example.com/deploy-2026-04.png"
})
```

---

## Error Responses

All error responses follow this format:

```json
{
  "status": 0,
  "errors": ["Description of the error"]
}
```

Common HTTP status codes: 400 (bad request), 401 (unauthorized), 404 (not found), 500 (server error).

---

## WebSocket Real-Time Updates

Connect to `wss://push.example.com/ws` for real-time message updates.

After connecting, send an auth message:

```json
{ "type": "auth", "userId": "YOUR_USER_ID" }
```

New messages arrive as:

```json
{
  "type": "new_message",
  "message": { ... }
}
```
