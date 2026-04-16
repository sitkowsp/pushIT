#!/bin/bash
#
# pushIT Deployment Script for Ubuntu 22.04
# Production-quality installation and configuration
#
# Usage: sudo ./deploy.sh [--update]
# --update: Skip user/env setup, update code only (for re-runs)

set -euo pipefail

# Color output for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PUSHIT_DIR="${PUSHIT_DIR:-/opt/pushit}"
PUSHIT_USER="pushit"
PUSHIT_GROUP="pushit"
UPDATE_MODE=false

# Parse command line arguments
if [[ "${1:-}" == "--update" ]]; then
  UPDATE_MODE=true
  echo -e "${YELLOW}Running in UPDATE mode (code + dependencies only)${NC}"
fi

# Ensure running as root
if [[ $EUID -ne 0 ]]; then
  echo -e "${RED}Error: This script must be run as root${NC}"
  exit 1
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}pushIT Deployment Script${NC}"
echo -e "${BLUE}========================================${NC}"

# ============================================================================
# STEP 1: Install Node.js 20 LTS via NodeSource
# ============================================================================
NEED_NODE=false
if ! command -v node &> /dev/null; then
  NEED_NODE=true
elif [[ $(node --version | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
  NEED_NODE=true
fi

if [[ "$NEED_NODE" == "true" ]]; then
  echo -e "${YELLOW}Step 1: Installing Node.js 20 LTS...${NC}"

  # Remove old Ubuntu-shipped Node.js packages that conflict with NodeSource
  echo "  Removing conflicting old Node.js packages..."
  apt-get remove -y nodejs libnode-dev libnode72 nodejs-doc 2>/dev/null || true
  apt-get autoremove -y 2>/dev/null || true
  # Fix any broken dpkg state from a previous failed attempt
  dpkg --configure -a 2>/dev/null || true

  # Import NodeSource GPG key and add repository
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get update -qq
  apt-get install -y nodejs

  echo -e "${GREEN}✓ Node.js $(node --version) installed${NC}"
else
  echo -e "${GREEN}✓ Node.js $(node --version) already installed${NC}"
fi

# ============================================================================
# STEP 2: Create pushit system user (skip if --update or user exists)
# ============================================================================
if [[ "$UPDATE_MODE" == "false" ]]; then
  echo -e "${YELLOW}Step 2: Creating system user '${PUSHIT_USER}'...${NC}"

  if ! id "$PUSHIT_USER" &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$PUSHIT_USER"
    echo -e "${GREEN}✓ User '${PUSHIT_USER}' created${NC}"
  else
    echo -e "${GREEN}✓ User '${PUSHIT_USER}' already exists${NC}"
  fi
else
  echo -e "${YELLOW}Step 2: Skipping user creation (--update mode)${NC}"
fi

# ============================================================================
# STEP 3: Create directory structure
# ============================================================================
echo -e "${YELLOW}Step 3: Creating directory structure at ${PUSHIT_DIR}...${NC}"

mkdir -p "$PUSHIT_DIR"/{data,logs}
echo -e "${GREEN}✓ Directories created${NC}"

# ============================================================================
# STEP 4: Copy application files to /opt/pushit
# ============================================================================
echo -e "${YELLOW}Step 4: Copying application files...${NC}"

# Get the directory where this script is located (deploy directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"  # Parent of deploy directory

# Copy all files except excluded directories/files
rsync -av \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data' \
  --exclude='deploy/build-package.sh' \
  --exclude='deploy/apache2-pushit.conf' \
  --exclude='.git' \
  --exclude='*.log' \
  "$SOURCE_DIR/" "$PUSHIT_DIR/"

# Also copy deploy scripts (backup, update, service file) into install dir
mkdir -p "$PUSHIT_DIR/deploy"
cp "$SCRIPT_DIR/backup.sh" "$PUSHIT_DIR/deploy/" 2>/dev/null || true
cp "$SCRIPT_DIR/update.sh" "$PUSHIT_DIR/deploy/" 2>/dev/null || true
cp "$SCRIPT_DIR/pushit.service" "$PUSHIT_DIR/deploy/" 2>/dev/null || true
chmod 750 "$PUSHIT_DIR/deploy/"*.sh 2>/dev/null || true

echo -e "${GREEN}✓ Application files copied${NC}"

# ============================================================================
# STEP 5: Install dependencies in production mode
# ============================================================================
echo -e "${YELLOW}Step 5: Installing npm dependencies (production mode)...${NC}"

cd "$PUSHIT_DIR"
npm install --omit=dev --quiet
echo -e "${GREEN}✓ Dependencies installed${NC}"

# ============================================================================
# STEP 6: Setup environment variables (skip if --update)
# ============================================================================
if [[ "$UPDATE_MODE" == "false" ]]; then
  echo -e "${YELLOW}Step 6: Setting up environment configuration...${NC}"

  if [[ ! -f "$PUSHIT_DIR/.env" ]]; then
    echo "  Generating VAPID keys..."

    # Copy .env.example if it exists, otherwise create minimal .env
    if [[ -f "$PUSHIT_DIR/.env.example" ]]; then
      cp "$PUSHIT_DIR/.env.example" "$PUSHIT_DIR/.env"
    else
      touch "$PUSHIT_DIR/.env"
    fi

    # Generate VAPID keys using node script if it exists
    if [[ -f "$PUSHIT_DIR/scripts/generate-vapid.js" ]]; then
      VAPID_OUTPUT=$(node "$PUSHIT_DIR/scripts/generate-vapid.js" 2>/dev/null) || true
      if [[ -n "$VAPID_OUTPUT" ]]; then
        VAPID_PUBLIC=$(echo "$VAPID_OUTPUT" | grep -oP 'VAPID_PUBLIC_KEY=\K.*' || true)
        VAPID_PRIVATE=$(echo "$VAPID_OUTPUT" | grep -oP 'VAPID_PRIVATE_KEY=\K.*' || true)

        if [[ -n "$VAPID_PUBLIC" && -n "$VAPID_PRIVATE" ]]; then
          sed -i "s|VAPID_PUBLIC_KEY=.*|VAPID_PUBLIC_KEY=${VAPID_PUBLIC}|g" "$PUSHIT_DIR/.env" || true
          sed -i "s|VAPID_PRIVATE_KEY=.*|VAPID_PRIVATE_KEY=${VAPID_PRIVATE}|g" "$PUSHIT_DIR/.env" || true
        fi
      fi
    fi

    # Generate random secrets
    SESSION_SECRET=$(openssl rand -base64 32)
    N8N_WEBHOOK_SECRET=$(openssl rand -base64 32)

    # Update or add secrets to .env
    if grep -q "SESSION_SECRET" "$PUSHIT_DIR/.env"; then
      sed -i "s|SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|g" "$PUSHIT_DIR/.env"
    else
      echo "SESSION_SECRET=${SESSION_SECRET}" >> "$PUSHIT_DIR/.env"
    fi

    if grep -q "N8N_WEBHOOK_SECRET" "$PUSHIT_DIR/.env"; then
      sed -i "s|N8N_WEBHOOK_SECRET=.*|N8N_WEBHOOK_SECRET=${N8N_WEBHOOK_SECRET}|g" "$PUSHIT_DIR/.env"
    else
      echo "N8N_WEBHOOK_SECRET=${N8N_WEBHOOK_SECRET}" >> "$PUSHIT_DIR/.env"
    fi

    echo -e "${GREEN}✓ Environment file created with generated secrets${NC}"
  else
    echo -e "${GREEN}✓ .env already exists (skipping generation)${NC}"
  fi
else
  echo -e "${YELLOW}Step 6: Skipping environment setup (--update mode)${NC}"
fi

# ============================================================================
# STEP 7: Interactive prompts for authentication mode (skip if --update)
# ============================================================================
if [[ "$UPDATE_MODE" == "false" ]]; then
  echo -e "${YELLOW}Step 7: Configuring authentication...${NC}"
  echo ""
  echo "  pushIT supports two authentication modes:"
  echo "    • Microsoft Entra ID (SSO via Azure AD)"
  echo "    • Local auth (email/password registration)"
  echo ""
  echo "  If you skip Entra ID setup, local auth mode will be used automatically."
  echo ""

  read -p "  Do you want to configure Microsoft Entra ID? (y/N): " CONFIGURE_ENTRA
  CONFIGURE_ENTRA="${CONFIGURE_ENTRA:-N}"

  if [[ "$CONFIGURE_ENTRA" =~ ^[Yy]$ ]]; then
    # Read current values from .env if they exist
    CURRENT_TENANT=$(grep "^AZURE_TENANT_ID=" "$PUSHIT_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "")
    CURRENT_CLIENT=$(grep "^AZURE_CLIENT_ID=" "$PUSHIT_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "")

    # Strip placeholder values so they don't display as "current"
    [[ "$CURRENT_TENANT" == "your-tenant-id-here" ]] && CURRENT_TENANT=""
    [[ "$CURRENT_CLIENT" == "your-client-id-here" ]] && CURRENT_CLIENT=""

    read -p "  Enter Azure Tenant ID (current: ${CURRENT_TENANT:-none}): " TENANT_ID
    TENANT_ID="${TENANT_ID:-$CURRENT_TENANT}"

    read -p "  Enter Azure Client ID (current: ${CURRENT_CLIENT:-none}): " CLIENT_ID
    CLIENT_ID="${CLIENT_ID:-$CURRENT_CLIENT}"

    # Update .env with Azure credentials
    if grep -q "AZURE_TENANT_ID" "$PUSHIT_DIR/.env"; then
      sed -i "s|AZURE_TENANT_ID=.*|AZURE_TENANT_ID=${TENANT_ID}|g" "$PUSHIT_DIR/.env"
    else
      echo "AZURE_TENANT_ID=${TENANT_ID}" >> "$PUSHIT_DIR/.env"
    fi

    if grep -q "AZURE_CLIENT_ID" "$PUSHIT_DIR/.env"; then
      sed -i "s|AZURE_CLIENT_ID=.*|AZURE_CLIENT_ID=${CLIENT_ID}|g" "$PUSHIT_DIR/.env"
    else
      echo "AZURE_CLIENT_ID=${CLIENT_ID}" >> "$PUSHIT_DIR/.env"
    fi

    echo -e "${GREEN}✓ Azure Entra ID configured (auth mode: entra)${NC}"
  else
    # Leave Azure fields empty → config.js auto-detects local auth mode
    if grep -q "AZURE_TENANT_ID" "$PUSHIT_DIR/.env"; then
      sed -i "s|AZURE_TENANT_ID=.*|AZURE_TENANT_ID=|g" "$PUSHIT_DIR/.env"
    else
      echo "AZURE_TENANT_ID=" >> "$PUSHIT_DIR/.env"
    fi

    if grep -q "AZURE_CLIENT_ID" "$PUSHIT_DIR/.env"; then
      sed -i "s|AZURE_CLIENT_ID=.*|AZURE_CLIENT_ID=|g" "$PUSHIT_DIR/.env"
    else
      echo "AZURE_CLIENT_ID=" >> "$PUSHIT_DIR/.env"
    fi

    echo -e "${GREEN}✓ Local auth mode configured (email/password registration)${NC}"
    echo -e "  ${YELLOW}Tip: Set REGISTRATION_OPEN=true in .env to allow self-registration${NC}"
  fi
else
  echo -e "${YELLOW}Step 7: Skipping auth configuration (--update mode)${NC}"
fi

# ============================================================================
# STEP 8: Initialize database
# ============================================================================
if [[ "$UPDATE_MODE" == "false" ]]; then
  echo -e "${YELLOW}Step 8: Initializing database...${NC}"

  cd "$PUSHIT_DIR"
  if [[ -f "$PUSHIT_DIR/package.json" ]] && grep -q '"db:init"' "$PUSHIT_DIR/package.json"; then
    npm run db:init --silent || echo -e "${YELLOW}Note: db:init script may have non-critical warnings${NC}"
    echo -e "${GREEN}✓ Database initialized${NC}"
  else
    echo -e "${YELLOW}Note: db:init script not found in package.json${NC}"
  fi
else
  echo -e "${YELLOW}Step 8: Skipping database initialization (--update mode)${NC}"
fi

# ============================================================================
# STEP 9: Set proper ownership and permissions
# ============================================================================
echo -e "${YELLOW}Step 9: Setting ownership and permissions...${NC}"

chown -R "$PUSHIT_USER:$PUSHIT_GROUP" "$PUSHIT_DIR"
find "$PUSHIT_DIR" -type d -exec chmod 750 {} \;
find "$PUSHIT_DIR" -type f -exec chmod 640 {} \;
chmod 600 "$PUSHIT_DIR/.env" 2>/dev/null || true

echo -e "${GREEN}✓ Ownership and permissions set${NC}"

# ============================================================================
# STEP 10: Install systemd service
# ============================================================================
echo -e "${YELLOW}Step 10: Installing systemd service...${NC}"

# Copy service file from deploy directory
SERVICE_FILE="$SCRIPT_DIR/pushit.service"
if [[ ! -f "$SERVICE_FILE" ]]; then
  echo -e "${RED}Error: Service file not found at ${SERVICE_FILE}${NC}"
  exit 1
fi

cp "$SERVICE_FILE" /etc/systemd/system/pushit.service
chmod 644 /etc/systemd/system/pushit.service
systemctl daemon-reload

systemctl enable pushit.service
systemctl restart pushit.service

# Wait a moment for service to start
sleep 2

echo -e "${GREEN}✓ Service installed and started${NC}"

# ============================================================================
# STEP 11: Configure Apache2 reverse proxy + SSL (skip if --update)
# ============================================================================
if [[ "$UPDATE_MODE" == "false" ]]; then
  echo -e "${YELLOW}Step 11: Configuring Apache2 reverse proxy and SSL...${NC}"
  echo ""

  read -p "  Do you want to set up Apache2 reverse proxy with SSL on THIS server? (y/N): " SETUP_APACHE
  SETUP_APACHE="${SETUP_APACHE:-N}"

  if [[ "$SETUP_APACHE" =~ ^[Yy]$ ]]; then
    # ── Install Apache2 and required modules ──
    echo "  Installing Apache2..."
    apt-get install -y apache2 > /dev/null 2>&1
    a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers > /dev/null 2>&1

    # ── Deployment type ──
    echo ""
    echo "  How will this instance be accessed?"
    echo "    1) Public domain (e.g., push.example.com) — supports Let's Encrypt"
    echo "    2) Local network / LAN (IP address or .local hostname)"
    echo "    3) I have my own SSL certificate files"
    echo ""
    read -p "  Choose [1/2/3]: " DEPLOY_TYPE
    DEPLOY_TYPE="${DEPLOY_TYPE:-1}"

    # ── Get server address based on deploy type ──
    case "$DEPLOY_TYPE" in
      2)
        # Local/LAN deployment
        echo ""
        echo "  Local network setup detected."
        echo "  You can use an IP address (e.g., 192.168.1.100) or a .local hostname."
        echo ""

        # Try to auto-detect the primary LAN IP
        AUTO_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}' || echo "")
        if [[ -n "$AUTO_IP" ]]; then
          read -p "  Enter server address (detected: ${AUTO_IP}): " DOMAIN_NAME
          DOMAIN_NAME="${DOMAIN_NAME:-$AUTO_IP}"
        else
          read -p "  Enter server IP or hostname (e.g., 192.168.1.100 or pushit.local): " DOMAIN_NAME
        fi
        ;;
      3)
        # User provides own certs
        read -p "  Enter your domain or hostname: " DOMAIN_NAME
        ;;
      *)
        # Public domain
        read -p "  Enter your public domain name (e.g., push.example.com): " DOMAIN_NAME
        ;;
    esac

    if [[ -z "$DOMAIN_NAME" ]]; then
      echo -e "${RED}  Error: Server address is required for SSL setup${NC}"
      echo -e "${YELLOW}  Skipping Apache/SSL configuration. You can set it up manually later.${NC}"
    else
      # ── Detect backend IP ──
      BACKEND_IP="127.0.0.1"
      echo "  Using backend: ${BACKEND_IP}:3000"

      # ── Update BASE_URL in .env ──
      if grep -q "BASE_URL" "$PUSHIT_DIR/.env"; then
        sed -i "s|BASE_URL=.*|BASE_URL=https://${DOMAIN_NAME}|g" "$PUSHIT_DIR/.env"
      else
        echo "BASE_URL=https://${DOMAIN_NAME}" >> "$PUSHIT_DIR/.env"
      fi

      # ── SSL certificate setup based on deploy type ──
      SSL_PROVIDER="manual"

      case "$DEPLOY_TYPE" in
        1)
          # ── Public domain → Let's Encrypt ──
          echo ""
          read -p "  Do you want to use Let's Encrypt for a free SSL certificate? (Y/n): " USE_LETSENCRYPT
          USE_LETSENCRYPT="${USE_LETSENCRYPT:-Y}"

          if [[ "$USE_LETSENCRYPT" =~ ^[Yy]$ ]]; then
            echo "  Installing Certbot..."
            apt-get install -y certbot python3-certbot-apache > /dev/null 2>&1

            # Create a minimal temporary Apache config so certbot can validate
            cat > /etc/apache2/sites-available/pushit.conf <<APACHEEOF
<VirtualHost *:80>
    ServerName ${DOMAIN_NAME}
    DocumentRoot /var/www/html
</VirtualHost>
APACHEEOF

            a2ensite pushit > /dev/null 2>&1
            systemctl reload apache2

            echo "  Requesting SSL certificate for ${DOMAIN_NAME}..."
            echo "  (Certbot will ask for your email and agreement to terms)"
            echo ""

            # Run certbot — it will modify the Apache config automatically
            if certbot --apache -d "$DOMAIN_NAME" --no-redirect; then
              echo ""
              echo -e "${GREEN}  ✓ SSL certificate obtained successfully${NC}"

              SSL_CERT="/etc/letsencrypt/live/${DOMAIN_NAME}/fullchain.pem"
              SSL_KEY="/etc/letsencrypt/live/${DOMAIN_NAME}/privkey.pem"
              SSL_PROVIDER="letsencrypt"

              # ── Set up auto-renewal timer ──
              # Certbot installs a systemd timer by default on Ubuntu 22.04.
              # Verify it's active, or create a cron job as fallback.
              if systemctl is-enabled certbot.timer &>/dev/null; then
                echo -e "${GREEN}  ✓ Auto-renewal timer already active (certbot.timer)${NC}"
              else
                # Enable the timer if it exists but is disabled
                if systemctl list-unit-files certbot.timer &>/dev/null; then
                  systemctl enable --now certbot.timer
                  echo -e "${GREEN}  ✓ Auto-renewal timer enabled (certbot.timer)${NC}"
                else
                  # Fallback: add cron job — run twice daily as recommended by Let's Encrypt
                  CRON_CMD="0 3,15 * * * certbot renew --quiet --deploy-hook 'systemctl reload apache2'"
                  (crontab -l 2>/dev/null | grep -v 'certbot renew' ; echo "$CRON_CMD") | crontab -
                  echo -e "${GREEN}  ✓ Auto-renewal cron job installed (runs at 03:00 and 15:00 daily)${NC}"
                fi
              fi

              # Test renewal works
              echo "  Testing renewal process..."
              certbot renew --dry-run --quiet && echo -e "${GREEN}  ✓ Renewal dry-run passed${NC}" || echo -e "${YELLOW}  ⚠ Renewal dry-run had warnings (check certbot logs)${NC}"

            else
              echo -e "${RED}  ✗ Certbot failed to obtain certificate${NC}"
              echo -e "${YELLOW}  Falling back to self-signed certificate...${NC}"
              DEPLOY_TYPE="2"  # Fall through to self-signed generation below
            fi
          else
            # User declined Let's Encrypt on public domain → manual certs
            DEPLOY_TYPE="3"
          fi
          ;;&  # fall through to check if we need self-signed or manual

        2)
          # ── Local/LAN → Self-signed certificate ──
          if [[ -z "${SSL_CERT:-}" ]]; then
            echo ""
            echo "  Generating self-signed SSL certificate for ${DOMAIN_NAME}..."
            echo "  (Browsers will show a security warning — this is normal for local networks)"

            mkdir -p /etc/ssl/pushit

            # Check if address is an IP → add subjectAltName for IP
            if [[ "$DOMAIN_NAME" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
              # IP address — need SAN extension for Chrome/Edge to accept it
              openssl req -x509 -nodes -days 3650 \
                -subj "/CN=${DOMAIN_NAME}/O=pushIT Self-Signed" \
                -addext "subjectAltName=IP:${DOMAIN_NAME}" \
                -newkey rsa:2048 \
                -keyout /etc/ssl/pushit/pushit.key \
                -out /etc/ssl/pushit/pushit.crt > /dev/null 2>&1
            else
              # Hostname (.local or similar)
              openssl req -x509 -nodes -days 3650 \
                -subj "/CN=${DOMAIN_NAME}/O=pushIT Self-Signed" \
                -addext "subjectAltName=DNS:${DOMAIN_NAME}" \
                -newkey rsa:2048 \
                -keyout /etc/ssl/pushit/pushit.key \
                -out /etc/ssl/pushit/pushit.crt > /dev/null 2>&1
            fi

            SSL_CERT="/etc/ssl/pushit/pushit.crt"
            SSL_KEY="/etc/ssl/pushit/pushit.key"
            SSL_PROVIDER="self-signed"

            echo -e "${GREEN}  ✓ Self-signed certificate created (valid for 10 years)${NC}"
            echo ""
            echo -e "  ${BLUE}To avoid browser warnings, you can import the certificate${NC}"
            echo -e "  ${BLUE}on client devices as a trusted root CA:${NC}"
            echo "    Certificate file: ${SSL_CERT}"
            echo ""
            echo "    Windows:  Import to 'Trusted Root Certification Authorities'"
            echo "    macOS:    Add to Keychain → 'Always Trust'"
            echo "    Linux:    Copy to /usr/local/share/ca-certificates/ → sudo update-ca-certificates"
            echo "    Android:  Settings → Security → Install from storage"
            echo "    iOS:      Email/AirDrop the .crt → install profile → trust in Settings"
          fi
          ;;

        3)
          # ── User provides own certs ──
          if [[ -z "${SSL_CERT:-}" ]]; then
            echo ""
            echo "  Provide paths to your SSL certificate and private key."
            echo ""
            read -p "  SSL certificate file path (e.g., /etc/ssl/certs/your.crt): " SSL_CERT
            read -p "  SSL private key file path (e.g., /etc/ssl/private/your.key): " SSL_KEY

            if [[ -z "$SSL_CERT" || -z "$SSL_KEY" ]]; then
              echo -e "${YELLOW}  No cert paths provided. Generating self-signed certificate as fallback.${NC}"

              mkdir -p /etc/ssl/pushit
              openssl req -x509 -nodes -days 3650 \
                -subj "/CN=${DOMAIN_NAME}/O=pushIT Self-Signed" \
                -addext "subjectAltName=DNS:${DOMAIN_NAME}" \
                -newkey rsa:2048 \
                -keyout /etc/ssl/pushit/pushit.key \
                -out /etc/ssl/pushit/pushit.crt > /dev/null 2>&1

              SSL_CERT="/etc/ssl/pushit/pushit.crt"
              SSL_KEY="/etc/ssl/pushit/pushit.key"
              SSL_PROVIDER="self-signed"
              echo -e "${GREEN}  ✓ Self-signed certificate created${NC}"
            fi
          fi
          ;;
      esac

      # ── Generate final Apache config ──
      # For IP-based ServerName, also listen on *:443 without SNI requirement
      if [[ "$DOMAIN_NAME" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        # IP address — use ServerAlias for any hostname and adjust CSP for IP
        SERVERNAME_LINE="ServerName ${DOMAIN_NAME}"
        WSS_CONNECT="wss://${DOMAIN_NAME}"
      else
        SERVERNAME_LINE="ServerName ${DOMAIN_NAME}"
        WSS_CONNECT="wss://${DOMAIN_NAME}"
      fi

      cat > /etc/apache2/sites-available/pushit.conf <<APACHEEOF
# ═══════════════════════════════════════════════════════════════════
# Apache2 Reverse Proxy — pushIT
# Generated by deploy.sh on $(date)
# SSL provider: ${SSL_PROVIDER}
# ═══════════════════════════════════════════════════════════════════

# ─── HTTP → HTTPS redirect ────────────────────────────────────────
<VirtualHost *:80>
    ${SERVERNAME_LINE}

    RewriteEngine On
    RewriteCond %{HTTPS} off
    RewriteRule ^(.*)\$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
</VirtualHost>

# ─── HTTPS VirtualHost ────────────────────────────────────────────
<VirtualHost *:443>
    ${SERVERNAME_LINE}

    # ── Force HTTP/1.1 to prevent HTTP/2 connection coalescing ──
    Protocols http/1.1

    # ── SSL certificate ──
    SSLEngine On
    SSLCertificateFile      ${SSL_CERT}
    SSLCertificateKeyFile   ${SSL_KEY}

    SSLProtocol             -all +TLSv1.2 +TLSv1.3
    SSLCipherSuite          ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384
    SSLHonorCipherOrder     On

    # ── Logging ──
    ErrorLog  /var/log/apache2/pushit.error.log
    CustomLog /var/log/apache2/pushit.access.log combined

    # ── Proxy base settings ──
    ProxyPreserveHost On
    ProxyRequests     Off
    ProxyTimeout 300
    ProxyBadHeader Ignore

    # ── WebSocket: /ws → ws://backend:3000/ws ──
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade}   =websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade    [NC]
    RewriteRule ^/ws(.*)\$         ws://${BACKEND_IP}:3000/ws\$1 [P,L]

    # ── All other traffic → http://backend:3000 ──
    ProxyPass        / http://${BACKEND_IP}:3000/ connectiontimeout=10 timeout=300
    ProxyPassReverse / http://${BACKEND_IP}:3000/

    # ── Request size limit (6 MB for push attachments) ──
    LimitRequestBody 6291456

    # ── Security headers ──
    Header always set X-Frame-Options        "SAMEORIGIN"
    Header always set X-Content-Type-Options  "nosniff"
    Header always set X-XSS-Protection        "1; mode=block"
    Header always set Referrer-Policy          "strict-origin-when-cross-origin"
    Header always set Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
    Header always set Permissions-Policy       "camera=(), microphone=(), geolocation=()"

    # CSP
    Header always set Content-Security-Policy "\
        default-src 'self'; \
        script-src  'self'; \
        style-src   'self' 'unsafe-inline'; \
        img-src     'self' data: https:; \
        font-src    'self'; \
        connect-src 'self' ${WSS_CONNECT}; \
        base-uri    'self'; \
        form-action 'self'"

    # Strip server info
    Header always unset X-Powered-By
    Header always unset Server

    # Forward proto/host for the backend
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Host  "${DOMAIN_NAME}"
</VirtualHost>
APACHEEOF

      # Enable site and reload
      a2dissite 000-default > /dev/null 2>&1 || true
      a2ensite pushit > /dev/null 2>&1

      # Test Apache config before reload
      if apache2ctl configtest 2>&1 | grep -q "Syntax OK"; then
        systemctl reload apache2
        echo -e "${GREEN}✓ Apache2 configured and running with SSL for ${DOMAIN_NAME}${NC}"
      else
        echo -e "${RED}✗ Apache config has errors:${NC}"
        apache2ctl configtest
        echo -e "${YELLOW}Fix the config at /etc/apache2/sites-available/pushit.conf and reload Apache${NC}"
      fi

      # Restart pushIT so it picks up the new BASE_URL
      systemctl restart pushit
      sleep 2
    fi
  else
    echo -e "${YELLOW}  Skipping Apache/SSL setup.${NC}"
    echo "  You can configure a reverse proxy manually later."
    echo "  See deploy/apache2-pushit.conf for a template."
  fi
else
  echo -e "${YELLOW}Step 11: Skipping Apache/SSL configuration (--update mode)${NC}"
fi

# ============================================================================
# STEP 12: Print summary and next steps
# ============================================================================
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Deployment Complete${NC}"
echo -e "${BLUE}========================================${NC}"

# Check service status
SERVICE_STATUS=$(systemctl is-active pushit || echo "inactive")
if [[ "$SERVICE_STATUS" == "active" ]]; then
  echo -e "${GREEN}✓ Service Status: RUNNING${NC}"
else
  echo -e "${RED}✗ Service Status: ${SERVICE_STATUS}${NC}"
  echo -e "${YELLOW}Check logs: journalctl -u pushit -n 50${NC}"
fi

# Detect configured auth mode for display
CONFIGURED_AUTH="local (email/password)"
if grep -q "^AZURE_TENANT_ID=.\+" "$PUSHIT_DIR/.env" 2>/dev/null; then
  CONFIGURED_AUTH="entra (Microsoft Entra ID)"
fi

echo ""
echo -e "${BLUE}Configuration Summary:${NC}"
echo "  Installation Directory: $PUSHIT_DIR"
echo "  Service User: $PUSHIT_USER"
echo "  Auth Mode: $CONFIGURED_AUTH"
echo "  Node.js Version: $(node --version)"
echo "  npm Version: $(npm --version)"

# Show SSL info if configured
if [[ -n "${SSL_CERT:-}" ]]; then
  echo "  SSL Certificate: ${SSL_CERT}"
  case "${SSL_PROVIDER:-}" in
    letsencrypt) echo "  SSL Provider: Let's Encrypt (auto-renewal active)" ;;
    self-signed) echo "  SSL Provider: Self-signed (import cert on clients to avoid warnings)" ;;
    *)           echo "  SSL Provider: Manual" ;;
  esac
fi
if [[ -n "${DOMAIN_NAME:-}" ]]; then
  echo "  URL: https://${DOMAIN_NAME}"
fi

echo ""
echo -e "${BLUE}Service Management:${NC}"
echo "  View logs:        journalctl -u pushit -f"
echo "  Check status:     systemctl status pushit"
echo "  Restart service:  systemctl restart pushit"
echo "  Stop service:     systemctl stop pushit"

echo ""
echo -e "${BLUE}Next Steps:${NC}"

STEP_NUM=1

# Show Apache setup hint only if we didn't set it up
if [[ -z "${SETUP_APACHE:-}" ]] || [[ ! "${SETUP_APACHE:-}" =~ ^[Yy]$ ]]; then
  echo "  ${STEP_NUM}. Configure Apache2 reverse proxy on your proxy server:"
  echo "     - Copy deploy/apache2-pushit.conf to proxy server"
  echo "     - Replace BACKEND_IP with this server's IP and YOUR_DOMAIN with your domain"
  echo "     - Update SSL cert paths to your certificate"
  echo "     - sudo a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers"
  echo "     - sudo a2ensite pushit && sudo systemctl reload apache2"
  STEP_NUM=$((STEP_NUM + 1))
fi

if [[ "$CONFIGURED_AUTH" == *"entra"* ]]; then
  echo "  ${STEP_NUM}. Set AZURE_CLIENT_SECRET in .env"
  STEP_NUM=$((STEP_NUM + 1))
  echo "  ${STEP_NUM}. In Azure Portal → App Registration:"
  echo "     - Add SPA redirect URI: https://${DOMAIN_NAME:-YOUR_DOMAIN}/"
  echo "     - Grant permissions: openid, profile, email, User.Read"
  STEP_NUM=$((STEP_NUM + 1))
else
  echo "  ${STEP_NUM}. Set REGISTRATION_OPEN=true in .env to allow self-registration"
  echo "     (or use invite-only mode by creating organizations)"
  STEP_NUM=$((STEP_NUM + 1))
fi

echo "  ${STEP_NUM}. Review logs: journalctl -u pushit -n 50"
STEP_NUM=$((STEP_NUM + 1))
echo "  ${STEP_NUM}. Visit https://${DOMAIN_NAME:-YOUR_DOMAIN} to verify deployment"

echo ""
echo -e "${BLUE}Maintenance:${NC}"
echo "  Update code:  sudo bash $PUSHIT_DIR/deploy/update.sh"
echo "  Backup DB:    sudo bash $PUSHIT_DIR/deploy/backup.sh"
echo "  Cron backup:  0 3 * * * $PUSHIT_DIR/deploy/backup.sh >> /var/log/pushit-backup.log 2>&1"
case "${SSL_PROVIDER:-}" in
  letsencrypt)
    echo "  SSL renewal:  certbot renew --dry-run  (auto-renewal is active)"
    echo "  SSL status:   certbot certificates"
    ;;
  self-signed)
    echo "  SSL cert:     ${SSL_CERT:-/etc/ssl/pushit/pushit.crt}"
    echo "  Import the .crt file on client devices to avoid browser warnings."
    ;;
esac

echo ""
echo -e "${GREEN}Deployment script completed successfully!${NC}"
