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
# STEP 7: Interactive prompts for Azure configuration (skip if --update)
# ============================================================================
if [[ "$UPDATE_MODE" == "false" ]]; then
  echo -e "${YELLOW}Step 7: Configuring Azure Entra ID credentials...${NC}"

  # Read current values from .env if they exist
  CURRENT_TENANT=$(grep "^AZURE_TENANT_ID=" "$PUSHIT_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "")
  CURRENT_CLIENT=$(grep "^AZURE_CLIENT_ID=" "$PUSHIT_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "")

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

  echo -e "${GREEN}✓ Azure credentials configured${NC}"
else
  echo -e "${YELLOW}Step 7: Skipping Azure configuration (--update mode)${NC}"
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
# STEP 11: Print summary and next steps
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

echo ""
echo -e "${BLUE}Configuration Summary:${NC}"
echo "  Installation Directory: $PUSHIT_DIR"
echo "  Service User: $PUSHIT_USER"
echo "  Node.js Version: $(node --version)"
echo "  npm Version: $(npm --version)"

echo ""
echo -e "${BLUE}Service Management:${NC}"
echo "  View logs:        journalctl -u pushit -f"
echo "  Check status:     systemctl status pushit"
echo "  Restart service:  systemctl restart pushit"
echo "  Stop service:     systemctl stop pushit"

echo ""
echo -e "${BLUE}Next Steps:${NC}"
echo "  1. Set AZURE_CLIENT_SECRET in .env if needed"
echo "  2. Configure Apache2 reverse proxy on your proxy server:"
echo "     - Copy deploy/apache2-pushit.conf to proxy server"
echo "     - Replace BACKEND_IP with this server's IP"
echo "     - Update SSL cert paths to your certificate"
echo "     - sudo a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers"
echo "     - sudo a2ensite pushit && sudo systemctl reload apache2"
echo "  3. In Azure Portal → App Registration:"
echo "     - Add SPA redirect URI: https://YOUR_DOMAIN/"
echo "     - Grant permissions: openid, profile, email, User.Read"
echo "  4. Review logs: journalctl -u pushit -n 50"
echo "  5. Visit https://YOUR_DOMAIN to verify deployment"
echo ""
echo -e "${BLUE}Maintenance:${NC}"
echo "  Update code:  sudo bash $PUSHIT_DIR/deploy/update.sh"
echo "  Backup DB:    sudo bash $PUSHIT_DIR/deploy/backup.sh"
echo "  Cron backup:  0 3 * * * $PUSHIT_DIR/deploy/backup.sh >> /var/log/pushit-backup.log 2>&1"

echo ""
echo -e "${GREEN}Deployment script completed successfully!${NC}"
