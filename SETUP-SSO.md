# pushIT — Application Proxy Header-based SSO Setup

This guide configures Azure Application Proxy to inject user identity headers
so the pushIT backend knows WHO is making each request. No MSAL or client-side
authentication is needed — the proxy handles everything.

## Prerequisites

- pushIT deployed and reachable via Application Proxy (pre-authentication ON)
- An Enterprise Application for pushIT in Entra ID
- The Application Proxy connector working (you can already reach the site)

## Step 1: Configure Header-based SSO

1. Go to **Microsoft Entra admin center** → **Enterprise Applications**
2. Select your **pushIT** application
3. In the left menu, click **Single sign-on**
4. Select **Header-based** as the SSO method

## Step 2: Map Claims to Headers

In the Header-based SSO configuration, add these claim-to-header mappings:

| Header Name          | Source Attribute              | Description            |
|----------------------|-------------------------------|------------------------|
| `x-user-email`       | `user.mail`                   | User's email address   |
| `x-user-displayname` | `user.displayname`            | User's full name       |
| `x-user-objectid`    | `user.objectid`               | Entra Object ID (GUID) |
| `x-user-upn`         | `user.userprincipalname`      | User Principal Name    |

> **Important:** The header names must be lowercase and match exactly what's in
> the pushIT server config. The defaults above work out of the box.

## Step 3: Save and Test

1. Click **Save** in the Azure Portal
2. On your phone/browser, navigate to `https://push.example.com/api/v1/auth/debug`
3. Check the JSON response:
   - `activeStrategy` should say **"Strategy 1 — Custom SSO Headers"**
   - Under `strategies`, the `willMatch` for Strategy 1 should be `true`
   - `allHeaders` should show your `x-user-*` headers with correct values

If Strategy 1 doesn't match, check:
- The SSO method is set to "Header-based" (not "None" or "Disabled")
- The header names match exactly (lowercase, hyphens not underscores)
- The source attributes are correct for your tenant

## Step 4: Deploy Updated Code

On your server:

```bash
# Copy the new package to your server
scp pushit-1.0.0.tar.gz user@your-server:/tmp/

# Extract and update
cd /tmp && tar -xzf pushit-1.0.0.tar.gz
cd pushit-1.0.0 && sudo bash deploy/update.sh
```

## Step 5: Clear Browser Caches

On every device that previously used pushIT:

- **Safari (iOS):** Settings → Safari → Clear History and Website Data
- **Safari (Mac):** Develop → Empty Caches, then hard refresh
- **Chrome/Edge:** Ctrl+Shift+Delete → Clear cached images and files
- Also consider unregistering the old service worker via DevTools → Application → Service Workers

## Alternative: If Header-based SSO Is Not Available

If your Entra ID plan doesn't include Header-based SSO for Application Proxy,
or it requires PingAccess, there are two fallback options:

### Option A: Token Passthrough

1. In the Enterprise Application → Application proxy settings
2. Enable "Translate URLs in headers" and token passthrough
3. The proxy will send `X-MS-TOKEN-AAD-ID-TOKEN` header
4. pushIT will automatically use Strategy 3 (token passthrough)

### Option B: Custom Header Names

If your proxy injects headers with different names, set them in `.env`:

```env
PROXY_HEADER_EMAIL=x-custom-email-header
PROXY_HEADER_DISPLAYNAME=x-custom-name-header
PROXY_HEADER_OBJECTID=x-custom-oid-header
PROXY_HEADER_UPN=x-custom-upn-header
```

Then restart the pushIT service: `sudo systemctl restart pushit`

## Troubleshooting

### Debug endpoint returns no headers

Visit `https://push.example.com/api/v1/auth/debug` and check `allHeaders`.

- If you see NO `x-user-*` or `x-ms-*` headers: SSO is not configured
- If you see `x-ms-token-aad-*`: Use Strategy 3 (token passthrough, works automatically)
- If you see custom headers with different names: Update `.env` to match

### 401 errors on all API calls

The debug endpoint doesn't require authentication — use it first to see what
headers the proxy is sending. Once you know which headers arrive, configure
the `.env` accordingly.

### App shows "Could not load profile"

This means the backend received the request but couldn't identify the user.
Check the debug endpoint to see which strategy is active.
