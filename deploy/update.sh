#!/bin/bash
#
# pushIT Quick Update Script
# Deploys code updates while preserving configuration and data
#
# Usage: sudo ./update.sh
# Safe for re-running - only updates code and dependencies

set -euo pipefail

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
PUSHIT_DIR="${PUSHIT_DIR:-/opt/pushit}"
PUSHIT_USER="pushit"
PUSHIT_GROUP="pushit"

# Ensure running as root
if [[ $EUID -ne 0 ]]; then
  echo -e "${RED}Error: This script must be run as root${NC}"
  exit 1
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}pushIT Quick Update${NC}"
echo -e "${BLUE}========================================${NC}"

# Verify pushIT directory exists
if [[ ! -d "$PUSHIT_DIR" ]]; then
  echo -e "${RED}Error: pushIT directory not found at ${PUSHIT_DIR}${NC}"
  echo "Run initial deployment with: sudo ./deploy.sh"
  exit 1
fi

# Get source directory (parent of deploy directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"

echo -e "${YELLOW}Stopping pushIT service...${NC}"
systemctl stop pushit
sleep 1

echo -e "${YELLOW}Backing up current version...${NC}"
BACKUP_DIR="${PUSHIT_DIR}/backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
# Backup only code files (not data or logs)
rsync -a \
  --exclude='data' \
  --exclude='logs' \
  --exclude='node_modules' \
  "$PUSHIT_DIR/" "$BACKUP_DIR/" > /dev/null 2>&1 || true

echo -e "${YELLOW}Comparing package.json...${NC}"
if [[ -f "$PUSHIT_DIR/package.json" && -f "$SOURCE_DIR/package.json" ]]; then
  if ! diff -q "$PUSHIT_DIR/package.json" "$SOURCE_DIR/package.json" > /dev/null; then
    echo -e "${YELLOW}Changes detected in package.json:${NC}"
    diff "$PUSHIT_DIR/package.json" "$SOURCE_DIR/package.json" || true
    echo ""
  fi
fi

echo -e "${YELLOW}Updating application files...${NC}"
rsync -av \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data' \
  --exclude='logs' \
  --exclude='deploy' \
  --exclude='.git' \
  --exclude='*.log' \
  "$SOURCE_DIR/" "$PUSHIT_DIR/"

echo -e "${YELLOW}Installing/updating dependencies...${NC}"
cd "$PUSHIT_DIR"
npm install --omit=dev --quiet

echo -e "${YELLOW}Setting proper ownership...${NC}"
chown -R "$PUSHIT_USER:$PUSHIT_GROUP" "$PUSHIT_DIR"
find "$PUSHIT_DIR" -type d -exec chmod 750 {} \;
find "$PUSHIT_DIR" -type f -exec chmod 640 {} \;
chmod 600 "$PUSHIT_DIR/.env" 2>/dev/null || true

echo -e "${YELLOW}Starting pushIT service...${NC}"
systemctl start pushit
sleep 2

# Check status
SERVICE_STATUS=$(systemctl is-active pushit || echo "inactive")

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Update Complete${NC}"
echo -e "${BLUE}========================================${NC}"

if [[ "$SERVICE_STATUS" == "active" ]]; then
  echo -e "${GREEN}✓ Service Status: RUNNING${NC}"
else
  echo -e "${RED}✗ Service Status: ${SERVICE_STATUS}${NC}"
  echo -e "${YELLOW}Check logs: journalctl -u pushit -n 50${NC}"
fi

echo ""
echo -e "${BLUE}Update Information:${NC}"
echo "  Code updated at: $(date)"
echo "  Backup location: $BACKUP_DIR"
echo "  Data preserved: Yes"
echo "  Configuration preserved: Yes"

echo ""
echo -e "${BLUE}Verification:${NC}"
echo "  View recent logs: journalctl -u pushit -n 20"
echo "  Full service status: systemctl status pushit"

if [[ "$SERVICE_STATUS" != "active" ]]; then
  echo ""
  echo -e "${YELLOW}Troubleshooting:${NC}"
  echo "  Last 50 lines of logs:"
  journalctl -u pushit -n 50 | tail -20
fi

echo ""
echo -e "${GREEN}Update completed successfully!${NC}"
