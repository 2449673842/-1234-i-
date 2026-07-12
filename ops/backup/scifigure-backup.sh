#!/usr/bin/env bash
set -Eeuo pipefail

DATA_DIR="${SCIFIGURE_DATA_DIR:-/srv/scifigure/data}"
RETENTION_DAILY="${SCIFIGURE_BACKUP_KEEP_DAILY:-7}"
RETENTION_WEEKLY="${SCIFIGURE_BACKUP_KEEP_WEEKLY:-4}"
RETENTION_MONTHLY="${SCIFIGURE_BACKUP_KEEP_MONTHLY:-6}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_env() {
  if [[ -z "${!1:-}" ]]; then
    echo "Missing required environment variable: $1" >&2
    exit 1
  fi
}

require_command restic
require_command sqlite3
require_command rsync
require_env RESTIC_REPOSITORY
require_env RESTIC_PASSWORD_FILE

if [[ ! -d "$DATA_DIR" ]]; then
  echo "SciFig data directory does not exist: $DATA_DIR" >&2
  exit 1
fi

if [[ ! -r "$RESTIC_PASSWORD_FILE" ]]; then
  echo "RESTIC_PASSWORD_FILE is not readable" >&2
  exit 1
fi

password_mode="$(stat -c '%a' "$RESTIC_PASSWORD_FILE")"
if [[ "$password_mode" != "600" && "$password_mode" != "400" ]]; then
  echo "RESTIC_PASSWORD_FILE must have mode 600 or 400, got $password_mode" >&2
  exit 1
fi

stage_dir="$(mktemp -d /tmp/scifigure-backup.XXXXXX)"
cleanup() {
  rm -rf -- "$stage_dir"
}
trap cleanup EXIT

rsync -a --delete --exclude 'scifigure.db' --exclude 'scifigure.db-wal' --exclude 'scifigure.db-shm' "$DATA_DIR/" "$stage_dir/"

if [[ -f "$DATA_DIR/scifigure.db" ]]; then
  sqlite3 "$DATA_DIR/scifigure.db" ".timeout 10000" ".backup '$stage_dir/scifigure.db'"
  integrity="$(sqlite3 "$stage_dir/scifigure.db" 'PRAGMA integrity_check;')"
  if [[ "$integrity" != "ok" ]]; then
    echo "SQLite backup integrity check failed: $integrity" >&2
    exit 1
  fi
fi

restic backup "$stage_dir" --tag scifigure --tag production
restic forget \
  --tag scifigure \
  --keep-daily "$RETENTION_DAILY" \
  --keep-weekly "$RETENTION_WEEKLY" \
  --keep-monthly "$RETENTION_MONTHLY" \
  --prune

echo "SciFig encrypted backup completed successfully."
