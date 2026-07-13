#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "rollback.sh must run as root" >&2
  exit 1
fi

state_dir=/var/lib/scifigure/deployment
previous_file="$state_dir/previous-release"
previous_env="$state_dir/previous-release.env"
current_link=/opt/scifigure/current
release_env=/etc/scifigure/release.env
ready_url=http://127.0.0.1:3101/api/health/ready

wait_for_ready() {
  local label="$1"
  local deadline=$((SECONDS + ${SCIFIGURE_DEPLOY_READY_SECONDS:-120}))
  until curl --noproxy '*' --fail --silent --show-error "$ready_url" >/dev/null; do
    if (( SECONDS >= deadline )) || ! systemctl is-active --quiet scifigure.service; then
      echo "Readiness failed: $label" >&2
      return 1
    fi
    sleep 1
  done
}

stop_service() {
  local state
  state="$(systemctl is-active scifigure.service 2>/dev/null || true)"
  case "$state" in
    active|activating|reloading|deactivating) systemctl stop scifigure.service ;;
  esac
  state="$(systemctl is-active scifigure.service 2>/dev/null || true)"
  case "$state" in
    active|activating|reloading|deactivating)
      echo "SciFigure service did not stop cleanly: $state" >&2
      return 1
      ;;
  esac
}

start_and_wait() {
  local label="$1"
  systemctl reset-failed scifigure.service 2>/dev/null || true
  if ! systemctl start scifigure.service; then
    echo "Service start failed: $label" >&2
    return 1
  fi
  wait_for_ready "$label"
}

if [[ ! -r "$previous_file" || ! -r "$previous_env" ]]; then
  echo "No recorded last-known-good release is available" >&2
  exit 1
fi

target_release="$(readlink -f "$(cat "$previous_file")")"
case "$target_release" in
  /opt/scifigure/releases/*) ;;
  *) echo "Invalid rollback release path: $target_release" >&2; exit 1 ;;
esac
if [[ ! -r "$target_release/dist/server.cjs" ]]; then
  echo "Rollback release is incomplete: $target_release" >&2
  exit 1
fi

old_release="$(readlink -f "$current_link")"
old_env="$(mktemp "$state_dir/current-release-env.XXXXXX")"
cp -- "$release_env" "$old_env"
next_link="${current_link}.next"

stop_service
ln -sfn "$target_release" "$next_link"
mv -Tf "$next_link" "$current_link"
cp -- "$previous_env" "$release_env"
chown root:scifigure "$release_env"
chmod 0640 "$release_env"
if ! start_and_wait "rollback target"; then
  journalctl -u scifigure.service -n 100 --no-pager >&2 || true
  if ! stop_service; then
    echo "FATAL: failed rollback target is still running; release pointers were not restored" >&2
    rm -f -- "$old_env"
    exit 1
  fi
  ln -sfn "$old_release" "$next_link"
  mv -Tf "$next_link" "$current_link"
  cp -- "$old_env" "$release_env"
  chown root:scifigure "$release_env"
  chmod 0640 "$release_env"
  if start_and_wait "restored current release"; then
    echo "Rollback target failed readiness; current release restored" >&2
  else
    journalctl -u scifigure.service -n 100 --no-pager >&2 || true
    echo "FATAL: rollback target and restored current release both failed readiness" >&2
  fi
  rm -f -- "$old_env"
  exit 1
fi

printf '%s\n' "$old_release" > "$previous_file"
cp -- "$old_env" "$previous_env"
chmod 0600 "$previous_file" "$previous_env"
printf '%s\n' "$target_release" > "$state_dir/current-release"
chmod 0644 "$state_dir/current-release"
rm -f -- "$old_env"
echo "Rolled back to $target_release"
