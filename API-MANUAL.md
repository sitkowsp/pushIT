# pushIT API Manual (v1.12.0)

## Authentication

All message-sending endpoints authenticate via **app token**. Include your token in the request body as the `token` field, or as a `Bearer` token in the `Authorization` header.

User-facing endpoints (reading messages, managing apps/filters) authenticate via **session cookie** (set by the OAuth2 or local login flow).

Get your app token from the **Apps** tab in the pushIT web interface.

### CSRF protection

All browser-session **POST**, **PUT**, and **DELETE** requests require the `X-Requested-With` header. The value can be anything (the PWA sends `XMLHttpRequest`). Requests without this header are rejected with **403 Forbidden**. This does not apply to app-token-authenticated endpoints (sending messages, checking receipts).

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
| `limit`   | integer | 50      | Max messages to return (clamped to max 200) |
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

> **v1.12.0:** Owned public apps now also include an `org_visibility` object:
> ```json
> "org_visibility": {
>   "all_orgs": true,
>   "organizations": [{ "id": "uuid", "name": "Ops Team" }]
> }
> ```
> When `all_orgs` is `true`, the app is visible to everyone. When `false`, `organizations` lists the orgs it is restricted to.

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

> **v1.12.0:** Results are now filtered by org-visibility. Apps restricted to specific organizations are only shown to members of those organizations. Unrestricted apps remain visible to all users.

### Get app org-visibility

**GET** `/api/v1/applications/:id/visibility`

Get the org-visibility settings for a public app you own. Owner only.

```bash
curl -s https://push.example.com/api/v1/applications/APP_ID/visibility \
  -H "Cookie: connect.sid=SESSION" \
  -H "X-Requested-With: XMLHttpRequest"
```

Response:

```json
{
  "status": 1,
  "visible_orgs": [
    { "id": "org-uuid-1", "name": "Ops Team" }
  ],
  "all_user_orgs": [
    { "id": "org-uuid-1", "name": "Ops Team" },
    { "id": "org-uuid-2", "name": "Dev Team" }
  ],
  "all_orgs": false
}
```

| Field           | Type    | Description                                                    |
|-----------------|---------|----------------------------------------------------------------|
| `visible_orgs`  | array   | Organizations the app is currently restricted to               |
| `all_user_orgs` | array   | All organizations the authenticated user belongs to            |
| `all_orgs`      | boolean | `true` if the app is visible to everyone (no restrictions)     |

### Set app org-visibility

**PUT** `/api/v1/applications/:id/visibility`

Set org-visibility restrictions for a public app you own. Owner only.

**Make visible to everyone (remove restrictions):**

```bash
curl -s -X PUT https://push.example.com/api/v1/applications/APP_ID/visibility \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=SESSION" \
  -H "X-Requested-With: XMLHttpRequest" \
  -d '{ "all_orgs": true }'
```

**Restrict to specific organizations:**

```bash
curl -s -X PUT https://push.example.com/api/v1/applications/APP_ID/visibility \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=SESSION" \
  -H "X-Requested-With: XMLHttpRequest" \
  -d '{ "organization_ids": ["org-uuid-1", "org-uuid-2"] }'
```

Only accepts organizations where the authenticated user is a member. Returns an error if no valid organization IDs are provided.

```json
{ "status": 1 }
```

### Subscribe / Unsubscribe

**POST** `/api/v1/applications/:id/subscribe` — Subscribe to a public app.

> **v1.12.0:** This endpoint now enforces org-visibility restrictions. If the app is restricted to specific organizations and the user is not a member of any allowed organization, the request is rejected with **403 Forbidden**.

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

Returns all **active** registered devices for the current user with push status. Soft-deleted devices are not included.

```json
{
  "status": 1,
  "devices": [
    {
      "id": "uuid",
      "name": "windows-chrome",
      "is_active": 1,
      "has_push": true,
      "created_at": "2026-04-15 12:00:00",
      "last_seen": "2026-04-15 12:34:56"
    }
  ]
}
```

### Register / re-subscribe a device

**POST** `/api/v1/devices/register`

Called by the PWA after the user grants notification permission. Body:

```json
{
  "name": "windows-chrome",
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/...",
    "keys": { "p256dh": "...", "auth": "..." }
  },
  "user_agent": "Mozilla/5.0 ..."
}
```

Matching rules:

1. If a device with the **same `push_endpoint`** already exists for the user, it is updated in place (same browser re-subscribing). The stored name — including any custom name set via rename — is preserved.
2. Otherwise a new device row is created. If the requested `name` is already taken by another active device for the user, the server appends `-2`, `-3`, … to make it unique. The actual stored name is returned in the response.

```json
{ "status": 1, "device": { "id": "uuid", "name": "windows-chrome-2", "is_active": 1, "has_push": true } }
```

### Rename a device

**PUT** `/api/v1/devices/:id`

```json
{ "name": "home-pc" }
```

Validation: 1–64 characters; allowed characters are letters, digits, dash (`-`), underscore (`_`), dot (`.`), and space. Returns **409 Conflict** if another active device for the same user already uses that name.

### Delete a device

**DELETE** `/api/v1/devices/:id`

Soft-deletes the device: sets `is_active = 0`, clears the push subscription, and removes it from `GET /api/v1/devices`. Existing message history that references the device is preserved.

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

## Auth Config

**GET** `/api/v1/auth/config`

Returns the server's authentication mode and registration status. No authentication required.

```json
{
  "authMode": "local",
  "registrationOpen": true,
  "vapidPublicKey": "BEl62i...",
  "smtpConfigured": true
}
```

| Field              | Type    | Description                                                    |
|--------------------|---------|----------------------------------------------------------------|
| `authMode`         | string  | `"entra"` (Microsoft Entra ID) or `"local"` (email/password)  |
| `registrationOpen` | boolean | Whether self-registration is open (local auth only)            |
| `vapidPublicKey`   | string  | VAPID public key for push subscription                         |
| `smtpConfigured`   | boolean | Whether SMTP is configured on the server (v1.12.0)            |

---

## Local Auth

These endpoints are only active when the server is configured with `AUTH_MODE=local`. They return **404** when `AUTH_MODE=entra`.

All local auth endpoints set or consume a session cookie. No app token is used.

### Register

**POST** `/api/v1/local-auth/register`

Create a new account. Only available when self-registration is open.

```json
POST /api/v1/local-auth/register
Content-Type: application/json

{
  "email": "alice@example.com",
  "password": "s3cureP@ss",
  "display_name": "Alice"
}
```

| Parameter      | Type   | Required | Description           |
|----------------|--------|----------|-----------------------|
| `email`        | string | Yes      | Email address         |
| `password`     | string | Yes      | Password              |
| `display_name` | string | Yes      | Display name          |

On success, a session cookie is set and the response confirms the account:

```json
{ "status": 1 }
```

### Login

**POST** `/api/v1/local-auth/login`

Authenticate with email and password. Sets a session cookie on success.

```json
POST /api/v1/local-auth/login
Content-Type: application/json

{
  "email": "alice@example.com",
  "password": "s3cureP@ss"
}
```

| Parameter  | Type   | Required | Description   |
|------------|--------|----------|---------------|
| `email`    | string | Yes      | Email address |
| `password` | string | Yes      | Password      |

```json
{ "status": 1 }
```

### Verify email

**GET** `/api/v1/local-auth/verify-email/:token`

Verifies the user's email address using the token sent during registration.

```
GET /api/v1/local-auth/verify-email/abc123def456
```

Returns a success or error page/response depending on token validity.

### Forgot password

**POST** `/api/v1/local-auth/forgot-password`

Request a password reset link. The server sends an email with a reset token.

```json
POST /api/v1/local-auth/forgot-password
Content-Type: application/json

{
  "email": "alice@example.com"
}
```

| Parameter | Type   | Required | Description   |
|-----------|--------|----------|---------------|
| `email`   | string | Yes      | Email address |

```json
{ "status": 1 }
```

The response always returns success regardless of whether the email exists, to prevent enumeration.

### Reset password

**POST** `/api/v1/local-auth/reset-password`

Set a new password using the token received via email.

```json
POST /api/v1/local-auth/reset-password
Content-Type: application/json

{
  "token": "reset-token-from-email",
  "password": "newS3cureP@ss"
}
```

| Parameter  | Type   | Required | Description               |
|------------|--------|----------|---------------------------|
| `token`    | string | Yes      | Reset token from the email |
| `password` | string | Yes      | New password               |

```json
{ "status": 1 }
```

### Register via invite

**POST** `/api/v1/local-auth/register-invite`

Register a new account using an organization invite token. This endpoint works even when self-registration is closed.

```json
POST /api/v1/local-auth/register-invite
Content-Type: application/json

{
  "invite_token": "org-invite-token",
  "password": "s3cureP@ss",
  "display_name": "Bob"
}
```

| Parameter      | Type   | Required | Description                        |
|----------------|--------|----------|------------------------------------|
| `invite_token` | string | Yes      | Invite token from the organization |
| `password`     | string | Yes      | Password                           |
| `display_name` | string | Yes      | Display name                       |

On success, a session cookie is set and the user is added to the inviting organization:

```json
{ "status": 1 }
```

---

## Organizations

Organization endpoints require session cookie authentication. Organizations let users group together and share apps within a team.

### List organizations

**GET** `/api/v1/organizations`

Returns all organizations the authenticated user belongs to.

```json
{
  "status": 1,
  "organizations": [
    {
      "id": "uuid",
      "name": "Ops Team",
      "role": "owner",
      "created_at": "2026-04-10T08:00:00.000Z"
    }
  ]
}
```

### Create organization

**POST** `/api/v1/organizations`

```json
POST /api/v1/organizations
Content-Type: application/json

{
  "name": "Ops Team"
}
```

| Parameter | Type   | Required | Description       |
|-----------|--------|----------|-------------------|
| `name`    | string | Yes      | Organization name |

The creating user becomes the organization owner.

```json
{ "status": 1, "organization": { "id": "uuid", "name": "Ops Team" } }
```

### Get organization details

**GET** `/api/v1/organizations/:id`

Returns organization info, its member list, and pending invites.

> **v1.12.0:** For owners, each invite in the response now includes `token` and `invite_url` fields, allowing the invite link to be copied directly from the UI without re-sending.

```json
{
  "status": 1,
  "organization": {
    "id": "uuid",
    "name": "Ops Team",
    "created_at": "2026-04-10T08:00:00.000Z"
  },
  "members": [
    {
      "user_id": "uuid",
      "display_name": "Alice",
      "email": "alice@example.com",
      "role": "owner"
    },
    {
      "user_id": "uuid",
      "display_name": "Bob",
      "email": "bob@example.com",
      "role": "member"
    }
  ],
  "invites": [
    {
      "id": "uuid",
      "email": "charlie@example.com",
      "token": "invite-token-string",
      "invite_url": "https://push.example.com/invite/invite-token-string",
      "created_at": "2026-04-10T08:00:00.000Z"
    }
  ]
}
```

### Update organization

**PUT** `/api/v1/organizations/:id`

Update the organization name. Owner only.

```json
{ "name": "New Team Name" }
```

### Invite a user

**POST** `/api/v1/organizations/:id/invite`

Send an invite email to a new or existing user. Owner only.

```json
POST /api/v1/organizations/:id/invite
Content-Type: application/json

{
  "email": "bob@example.com"
}
```

| Parameter | Type   | Required | Description                   |
|-----------|--------|----------|-------------------------------|
| `email`   | string | Yes      | Email address of the invitee  |

```json
{ "status": 1 }
```

If the email belongs to an existing user, they receive an invite they can accept. If not, the invite link allows them to register via `POST /api/v1/local-auth/register-invite`.

### List pending invites

**GET** `/api/v1/organizations/:id/invites`

Returns all pending (unaccepted) invites for the organization. Owner only.

```json
{
  "status": 1,
  "invites": [
    {
      "id": "uuid",
      "email": "bob@example.com",
      "created_at": "2026-04-10T08:00:00.000Z"
    }
  ]
}
```

### Delete invite

**DELETE** `/api/v1/organizations/:id/invites/:inviteId`

Revoke a pending invite. Owner only.

```bash
curl -s -X DELETE https://push.example.com/api/v1/organizations/ORG_ID/invites/INVITE_ID \
  -H "Cookie: connect.sid=SESSION" \
  -H "X-Requested-With: XMLHttpRequest"
```

```json
{ "status": 1 }
```

### Resend invite

**POST** `/api/v1/organizations/:id/invites/:inviteId/resend`

Re-send the invite email for a pending invite. Owner only. Requires SMTP to be configured on the server.

```bash
curl -s -X POST https://push.example.com/api/v1/organizations/ORG_ID/invites/INVITE_ID/resend \
  -H "Cookie: connect.sid=SESSION" \
  -H "X-Requested-With: XMLHttpRequest"
```

```json
{ "status": 1 }
```

### Accept invite

**POST** `/api/v1/organizations/accept-invite/:token`

Accept an organization invite. Requires session cookie authentication (the user must already be logged in).

```
POST /api/v1/organizations/accept-invite/invite-token-here
```

```json
{ "status": 1 }
```

### Remove member

**DELETE** `/api/v1/organizations/:id/members/:userId`

Remove a member from the organization. Owner only.

```
DELETE /api/v1/organizations/:id/members/:userId
```

```json
{ "status": 1 }
```

### Delete organization

**DELETE** `/api/v1/organizations/:id`

Delete the organization and remove all memberships. Owner only.

```
DELETE /api/v1/organizations/:id
```

```json
{ "status": 1 }
```

---

## SMTP Settings

SMTP settings endpoints require session cookie authentication and **admin** role. These endpoints allow admins to configure outbound email (used for invites, password resets, email verification, etc.) via the web interface.

SMTP can be configured in two ways: via environment variables (`.env`) or via the database (these endpoints). Environment variable configuration takes precedence and cannot be overridden or removed through the API.

### Get SMTP configuration

**GET** `/api/v1/settings/smtp`

Returns the current SMTP configuration status. The password is never returned.

```bash
curl -s https://push.example.com/api/v1/settings/smtp \
  -H "Cookie: connect.sid=SESSION" \
  -H "X-Requested-With: XMLHttpRequest"
```

Response:

```json
{
  "status": 1,
  "smtp": {
    "configured": true,
    "source": "database",
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "notifications@example.com",
    "from": "pushIT <notifications@example.com>"
  },
  "envConfigured": false
}
```

| Field             | Type    | Description                                                  |
|-------------------|---------|--------------------------------------------------------------|
| `smtp.configured` | boolean | Whether SMTP is currently configured (from any source)       |
| `smtp.source`     | string  | `"env"` or `"database"` — where the active config comes from |
| `smtp.host`       | string  | SMTP server hostname                                         |
| `smtp.port`       | integer | SMTP server port                                             |
| `smtp.secure`     | boolean | Whether TLS is used                                          |
| `smtp.user`       | string  | SMTP username                                                |
| `smtp.from`       | string  | From address for outbound emails                             |
| `envConfigured`   | boolean | `true` if `.env` has SMTP variables set                      |

### Save SMTP configuration

**POST** `/api/v1/settings/smtp`

Save SMTP configuration to the database. Cannot override `.env` configuration — if SMTP is already configured via environment variables, this endpoint returns an error.

```bash
curl -s -X POST https://push.example.com/api/v1/settings/smtp \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=SESSION" \
  -H "X-Requested-With: XMLHttpRequest" \
  -d '{
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "notifications@example.com",
    "pass": "smtp-password",
    "from": "pushIT <notifications@example.com>"
  }'
```

| Parameter | Type    | Required | Description                    |
|-----------|---------|----------|--------------------------------|
| `host`    | string  | Yes      | SMTP server hostname           |
| `port`    | integer | No       | SMTP server port               |
| `secure`  | boolean | No       | Use TLS                        |
| `user`    | string  | Yes      | SMTP username                  |
| `pass`    | string  | No       | SMTP password                  |
| `from`    | string  | No       | From address for outbound mail |

```json
{ "status": 1 }
```

### Remove SMTP configuration

**DELETE** `/api/v1/settings/smtp`

Remove the database-stored SMTP configuration. Cannot remove `.env` configuration.

```bash
curl -s -X DELETE https://push.example.com/api/v1/settings/smtp \
  -H "Cookie: connect.sid=SESSION" \
  -H "X-Requested-With: XMLHttpRequest"
```

```json
{ "status": 1 }
```

### Test SMTP configuration

**POST** `/api/v1/settings/smtp/test`

Send a test email to the admin's own email address to verify SMTP settings. Admin only.

```bash
curl -s -X POST https://push.example.com/api/v1/settings/smtp/test \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=SESSION" \
  -H "X-Requested-With: XMLHttpRequest" \
  -d '{
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "notifications@example.com",
    "pass": "",
    "from": "pushIT <notifications@example.com>"
  }'
```

| Parameter | Type    | Required | Description                                                  |
|-----------|---------|----------|--------------------------------------------------------------|
| `host`    | string  | Yes      | SMTP server hostname                                         |
| `port`    | integer | No       | SMTP server port                                             |
| `secure`  | boolean | No       | Use TLS                                                      |
| `user`    | string  | Yes      | SMTP username                                                |
| `pass`    | string  | No       | SMTP password. If empty, uses the stored password from the DB |
| `from`    | string  | No       | From address for the test email                              |

```json
{ "status": 1 }
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

Authentication is automatic: the WebSocket upgrade request uses the session cookie, so no client-sent auth message is needed. The server identifies the user from the session on connect.

New messages arrive as:

```json
{
  "type": "new_message",
  "message": { ... }
}
```
