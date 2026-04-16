# pushIT User Guide

This guide covers the pushIT web app interface — the four main tabs and how to use each one.

After signing in, you'll see the bottom navigation bar with four tabs: **Messages**, **Apps**, **Filters**, and **Settings**.

---

## Signing In

pushIT supports two authentication modes depending on how your instance is configured.

### Microsoft Account

If the instance is connected to Microsoft Entra ID, tapping "Sign in" redirects you to your organization's Microsoft login page. Once authenticated, you're returned to pushIT and signed in automatically.

### Local Auth

If the instance is running in local auth mode (no Microsoft tenant configured), you'll see a login and registration form directly on the pushIT login screen.

#### Registering a new account

1. On the login screen, tap **Register**
2. Enter your desired display name, email address, and a password
3. Your password must be at least **8 characters** long and contain at least **one letter** and **one number**
4. Tap **Register** to create your account

You'll be signed in immediately after registering.

#### Logging in

1. Enter the email address and password you registered with
2. Tap **Login**

#### Forgot password

1. On the login screen, tap **Forgot Password**
2. Enter the email address you registered with
3. Check your email for a password reset link
4. Follow the link and enter a new password

If SMTP is not configured on the instance, contact your administrator to reset your password manually.

---

## Messages Tab

The Messages tab is your notification inbox. All push notifications sent to you appear here in reverse chronological order (newest first).

### Reading messages

Each message card shows the notification title, body text, timestamp, and the sending app's name with a colored indicator. Unread messages are visually highlighted. Tapping a message card marks it as read.

### Message actions

- **Delete** — tap the **x** button on any message card to delete it
- **Open Link** — if the notification includes a URL, a link button appears at the bottom of the card. Tap it to open the linked page
- **Acknowledge** — emergency priority (priority 2) messages show an "Acknowledge" button. Tap it to stop repeat notifications and confirm you've seen the alert
- **Images** — if the sender included an image URL, a preview is displayed below the message text

### Toolbar

At the top of the Messages tab you'll find:

- **Delete all** (trash icon) — removes all messages. If you have an active app filter, this deletes only messages from that filtered app
- **Refresh** (reload icon) — manually refreshes the message list (messages also arrive in real-time via WebSocket)

### Filtering by app

In the Apps tab, tapping an app's message count badge navigates to Messages filtered to that app only. A filter indicator appears at the top. Tap it to clear the filter and see all messages again.

### Empty state

When there are no messages, the tab shows a mailbox icon with "No messages yet — Push notifications from your apps and n8n will appear here."

---

## Apps Tab

The Apps tab is where you manage your notification sources. Each app has its own API token for sending notifications.

### App cards

Each app card displays:

- **App name** with a colored dot indicator
- **Message count** — how many messages this app has sent to you
- **Visibility badge** — "Public" (any user can subscribe) or "Private" (only the owner receives notifications)
- **API token** — tap the token field to copy it to your clipboard. Use this token in your API calls, n8n workflows, or scripts
- **Description** — a short note about what the app is for (if set)

### Managing apps you own

For apps you created, three action buttons appear:

- **Edit** — change the app name, description, color, icon URL, or visibility
- **Delete** — permanently remove the app and its token. This cannot be undone
- **Unsubscribe** — stop receiving notifications from this app (also deletes existing messages from it)

### Subscriber management

For apps you own, a **Subscribers (N)** button appears on the app card showing the current subscriber count. Tap it to open a modal listing all users subscribed to the app.

The subscriber list shows each user's name, email address, and organization memberships. The app owner is labeled **Owner** and cannot be removed.

For any other subscriber, a **Remove** button lets you force-unsubscribe them from the app. Removing a subscriber also deletes their messages from this app.

### Creating a new app

1. Tap **+ New App** in the top right
2. Fill in the app name (required), description (optional), and choose a color
3. Set visibility: **Private** (only you) or **Public** (anyone can subscribe)
4. Tap **Create**

Your new app appears with a generated API token. Copy this token — you'll need it for sending notifications via the API.

### Public apps

Tap **Browse Public Apps** at the bottom of the Apps list to see all public apps in your organization. From there you can subscribe to any app to start receiving its notifications.

For public apps you don't own, you'll see a **Subscribe** or **Unsubscribe** button.

---

## Filters Tab

Filters let you automatically route, modify, or suppress incoming notifications based on patterns. They're useful for forwarding critical alerts to a webhook, silencing noisy notifications, or routing specific messages to n8n workflows.

### Creating a filter

1. Tap **+ New Filter** in the top right
2. Configure the filter:
   - **Name** — a descriptive label for this filter (e.g., "Forward critical alerts")
   - **Title pattern** — regex pattern to match against the notification title (e.g., `CRITICAL|ERROR`)
   - **Message pattern** — regex pattern to match against the notification body (e.g., `server down`)
   - **Action** — what to do when a notification matches:
     - **Forward** — send the notification to a webhook URL (great for n8n integration)
     - **Suppress** — prevent the notification from being delivered
   - **Webhook URL** — the URL to forward matching notifications to (only shown when action is "Forward")
3. Tap **Create Filter**

### Managing filters

Each filter card shows its name, action type, webhook target (if forwarding), and the match patterns. Use the **toggle switch** on each filter card to enable or disable it without deleting it.

### How filters work

Filters are evaluated in order when a new notification arrives. If a notification's title or body matches the configured regex patterns, the filter's action is triggered. A single notification can match multiple filters.

### Empty state

When no filters are configured, the tab shows a magnifying glass icon with "No filters — Create filters to route, modify, or forward notifications."

---

## Settings Tab

The Settings tab shows your account info, push notification status, registered devices, and a built-in API reference.

### Account

Displays your name, email address, and your **User Key**. The User Key is what API callers use to target notifications to you specifically. Tap it to copy to clipboard.

### Notifications

Shows two status indicators:

- **Push Permission** — whether your browser/device has granted notification permission. Shows "granted" (green) when working correctly, or "denied"/"default" if not
- **Subscribed** — whether this device is actively registered for push notifications. Shows "Yes" (green) when subscribed

If push notifications aren't enabled, an **Enable Push Notifications** button appears. Tap it to request permission and subscribe this device.

### Devices

Lists all your registered devices with their names and status:

- **Active** (green) — device is registered and receiving push notifications
- **No push** — device is registered but push notifications aren't enabled
- **Inactive** — device hasn't connected recently

Device names are automatically detected from your browser and OS (e.g., "iphone-safari", "windows-chrome", "macos-edge").

Each device row has two buttons:

- **Rename** — give a device a friendly label (e.g., `home-pc`, `work-laptop`). Names must be 1–64 characters and may contain letters, digits, dashes, underscores, dots, and spaces. Names must be unique across your active devices.
- **Delete** — remove the device from your account. It will stop receiving push notifications and disappear from the list. Re-enabling push from that browser later will re-register it.

**Multiple devices with the same browser:** If you sign in on a second computer that has the same OS and browser as one already registered (for example, two Windows machines both using Chrome), the new device is automatically saved as `windows-chrome-2` instead of overwriting the first. The detection key is the browser's push subscription endpoint, so re-subscribing on the *same* browser keeps the same device row (and any custom name you gave it).

### API Usage

A built-in quick reference for the pushIT API. Each section is collapsible — tap a header to expand it:

- **Quick Start — curl** — a ready-to-use curl command with your User Key pre-filled
- **Broadcast to All Subscribers** — how to send to everyone subscribed to your app
- **All Parameters** — complete list of API parameters with descriptions and notes on platform support
- **With URL Button** — example with a clickable link in the notification
- **n8n HTTP Request Node** — configuration for n8n's HTTP Request node
- **PowerShell** — example using `Invoke-RestMethod`
- **Python** — example using the `requests` library
- **Response Format** — success and error response structures

All code examples use your actual User Key and your server's URL, so you can copy and paste them directly.

### Organizations

Organizations let you group users together and share apps across your team. You can create, join, and manage organizations from the Settings tab.

#### Creating an organization

1. In the Settings tab, find the **Organizations** section
2. Tap **Create Organization**
3. Enter a name for your organization
4. Tap **Create**

You become the owner of the new organization automatically.

#### Inviting members

1. Open your organization from the Settings tab
2. Tap **Invite Member**
3. Enter the email address of the person you want to invite
4. A **shareable invite link** is also available — copy it and send it to anyone you'd like to join. Anyone with the link can accept the invitation and join your organization

#### Managing pending invitations

When viewing an organization (tap **Manage**), pending invitations are listed with the following details and actions:

- **Invitation link** — the full invite URL is displayed and can be clicked or copied to share with the invitee
- **Re-send** — if SMTP is configured on the instance, a **Re-send** button appears next to each pending invitation to re-send the invite email
- **Delete** — tap **Delete** to revoke a pending invitation. The invite link will no longer work

#### Managing members

From your organization's member list you can:

- **View all members** — see who has joined your organization along with their roles
- **Remove a member** — tap the remove button next to a member's name to revoke their access. Removed members will no longer see org-scoped apps

#### Organization-scoped apps

Apps can be linked to an organization, making them visible to all members of that organization. When you create or edit an app, you can assign it to an organization you belong to. All members of that organization will then see the app in their Apps tab and can subscribe to receive its notifications. This is useful for shared alerting and team-wide notification sources.

#### App organization visibility

When creating or editing a **Public** app, if you belong to any organizations, a **Visible to organizations** section appears in the form:

- **All organizations** — checked by default. The app is visible to all users, regardless of organization membership
- When unchecked, a checkbox appears for each of your organizations. Only members of the selected organizations will be able to see and subscribe to the app

You can change this setting at any time by editing the app (tap **Edit** on the app card).

### Email (SMTP) — Admin only

Admins see an **Email (SMTP)** section in Settings for configuring outbound email (used for invitation emails, password resets, etc.).

The section displays one of three states:

- **Configured via .env** — SMTP settings were provided through environment variables. The configuration is shown as read-only
- **Configured via UI** — shows the current SMTP host, username, and from address, along with **Edit** and **Remove** buttons
- **Not configured** — shows a **Configure SMTP** button to set up email for the first time

#### Configuring SMTP

1. Tap **Configure SMTP** (or **Edit** if already configured)
2. Fill in the form:
   - **SMTP Host** — your mail server hostname (e.g., `smtp.example.com`)
   - **Port** — the SMTP port (e.g., 587)
   - **SSL/TLS** — toggle on if your server requires a secure connection
   - **Username** — your SMTP login username
   - **Password** — your SMTP login password
   - **From Address** — the email address that outgoing messages are sent from
3. Tap **Test** to send a test email to your own email address and verify the configuration works
4. Tap **Save** to store the configuration in the database

### Sign Out

Tap the red **Sign Out** button at the bottom to end your session and return to the login screen.

---

## Tips

- **HTTPS required for push**: Push notifications require HTTPS (or localhost). If your instance runs over plain HTTP on a LAN, push notifications will not work unless you access it from the same machine (localhost). Ask your admin about enabling SSL if you need push on other devices.

- **Install as PWA**: On iOS, open pushIT in Safari, tap Share, then "Add to Home Screen." On Android, tap the browser menu and "Install app." This gives you a native app experience with home screen icon and push notifications.

- **Multiple devices**: You can sign in on multiple devices (phone, tablet, desktop). Each device registers separately and receives push notifications independently.

- **Emergency notifications**: Priority 2 notifications repeat at the configured interval until you tap "Acknowledge." These are designed for critical alerts that require human confirmation.

- **Quick API test**: Go to Settings, expand the "Quick Start — curl" section, copy the command, replace `APP_TOKEN` with a real token from your Apps tab, and run it in a terminal to send yourself a test notification.
