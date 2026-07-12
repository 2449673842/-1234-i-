#!/usr/bin/env bash
set -Eeuo pipefail

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
require_env RESTIC_REPOSITORY
require_env RESTIC_PASSWORD_FILE

restore_dir="$(mktemp -d /tmp/scifigure-restore-verify.XXXXXX)"
cleanup() {
  rm -rf -- "$restore_dir"
}
trap cleanup EXIT

restic check --read-data-subset="${SCIFIGURE_BACKUP_CHECK_SUBSET:-5%}"
restic restore latest --tag scifigure --target "$restore_dir"

database_path="$(find "$restore_dir" -name scifigure.db -type f -print -quit)"
if [[ -z "$database_path" ]]; then
  echo "Restored backup does not contain scifigure.db" >&2
  exit 1
fi

integrity="$(sqlite3 "$database_path" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  echo "Restored SQLite integrity check failed: $integrity" >&2
  exit 1
fi

echo "SciFig restore verification passed."
