#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# pushIT — Build Deployable Package
# Creates a .tar.gz archive ready to copy to your Ubuntu 22.04 server
# Usage: bash deploy/build-package.sh
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")
PACKAGE_NAME="pushit-${VERSION}"
BUILD_DIR="/tmp/${PACKAGE_NAME}"
OUTPUT="${PROJECT_DIR}/${PACKAGE_NAME}.tar.gz"

echo "══════════════════════════════════════"
echo "  pushIT Package Builder v${VERSION}"
echo "══════════════════════════════════════"
echo ""

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "[1/5] Copying application files..."
rsync -a \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='.git/' \
  --exclude='*.tar.gz' \
  "$PROJECT_DIR/" "$BUILD_DIR/"

echo "[2/5] Verifying file structure..."
REQUIRED_FILES=(
  "package.json"
  "server/index.js"
  "server/config.js"
  "server/db/schema.sql"
  "server/db/db.js"
  "public/index.html"
  "public/manifest.json"
  "public/sw.js"
  ".env.example"
  "deploy/deploy.sh"
  "deploy/update.sh"
  "deploy/pushit.service"
  "deploy/apache2-pushit.conf"
)

MISSING=0
for f in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$BUILD_DIR/$f" ]; then
    echo "  MISSING: $f"
    MISSING=1
  fi
done

if [ "$MISSING" -eq 1 ]; then
  echo "ERROR: Missing required files. Build aborted."
  exit 1
fi
echo "  All required files present."

echo "[3/5] Setting file permissions..."
find "$BUILD_DIR" -type d -exec chmod 755 {} \;
find "$BUILD_DIR" -type f -exec chmod 644 {} \;
chmod 755 "$BUILD_DIR/deploy/deploy.sh"
chmod 755 "$BUILD_DIR/deploy/update.sh"
chmod 755 "$BUILD_DIR/deploy/build-package.sh"

echo "[4/5] Creating archive..."
cd /tmp
tar -czf "$OUTPUT" "$PACKAGE_NAME"
rm -rf "$BUILD_DIR"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "[5/5] Package created: $OUTPUT ($SIZE)"

echo ""
echo "══════════════════════════════════════"
echo "  Package ready!"
echo "══════════════════════════════════════"
echo ""
echo "  File: $OUTPUT"
echo "  Size: $SIZE"
echo ""
echo "  To deploy on your Ubuntu 22.04 server:"
echo ""
echo "  1. Copy to server:"
echo "     scp ${PACKAGE_NAME}.tar.gz user@your-server:/tmp/"
echo ""
echo "  2. SSH into server and extract:"
echo "     cd /tmp && tar -xzf ${PACKAGE_NAME}.tar.gz"
echo ""
echo "  3. Run the deploy script:"
echo "     cd /tmp/${PACKAGE_NAME} && sudo bash deploy/deploy.sh"
echo ""
echo "  4. For updates later:"
echo "     cd /tmp/${PACKAGE_NAME} && sudo bash deploy/update.sh"
echo ""
