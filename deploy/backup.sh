#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# pushIT — Database Backup Script
# Creates timestamped backups of the SQLite database
# Usage: sudo bash backup.sh [backup_dir]
# Recommended: Add to crontab for daily backups
#   0 3 * * * /opt/pushit/deploy/backup.sh >> /var/log/pushit-backup.log 2>&1
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

PUSHIT_DIR="/opt/pushit"
BACKUP_DIR="${1:-/opt/pushit/backups}"
DB_PATH="${PUSHIT_DIR}/data/pushit.db"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
KEEP_DAYS=30

# Create backup directory
mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "[$(date)] ERROR: Database not found at $DB_PATH"
  exit 1
fi

# Create backup
BACKUP_FILE="${BACKUP_DIR}/pushit_${TIMESTAMP}.db"
cp "$DB_PATH" "$BACKUP_FILE"
gzip "$BACKUP_FILE"

echo "[$(date)] Backup created: ${BACKUP_FILE}.gz ($(du -h "${BACKUP_FILE}.gz" | cut -f1))"

# Clean old backups
DELETED=$(find "$BACKUP_DIR" -name "pushit_*.db.gz" -mtime +${KEEP_DAYS} -delete -print | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "[$(date)] Cleaned $DELETED backup(s) older than ${KEEP_DAYS} days"
fi

# Set permissions
chown pushit:pushit "${BACKUP_FILE}.gz" 2>/dev/null || true
chmod 640 "${BACKUP_FILE}.gz" 2>/dev/null || true
