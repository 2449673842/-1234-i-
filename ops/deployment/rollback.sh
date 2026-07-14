#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "rollback.sh must run as root" >&2
  exit 1
fi

state_dir=/var/lib/scifigure/deployment
previous_file="$state_dir/previous-release"
previous_env="$state_dir/previous-release.env"
previous_unit="$state_dir/previous-service-unit"
current_link=/opt/scifigure/current
release_env=/etc/scifigure/release.env
service_unit=/etc/systemd/system/scifigure.service
current_file="$state_dir/current-release"
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

if [[ ! -r "$previous_file" || ! -r "$previous_env" || ! -r "$previous_unit" ]]; then
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
metadata_backup="$(mktemp -d "$state_dir/rollback-metadata-backup.XXXXXX")"
for state_name in previous-release previous-release.env previous-service-unit current-release; do
  if [[ -e "$state_dir/$state_name" ]]; then
    cp -a -- "$state_dir/$state_name" "$metadata_backup/$state_name"
  fi
done
old_env="$(mktemp "$state_dir/current-release-env.XXXXXX")"
old_unit="$(mktemp "$state_dir/current-service-unit.XXXXXX")"
cp -- "$release_env" "$old_env"
cp -- "$service_unit" "$old_unit"
next_link="${current_link}.next"
next_env="${release_env}.next"
next_unit="${service_unit}.next"
ln -sfn "$target_release" "$next_link"
cp -- "$previous_env" "$next_env"
chown root:scifigure "$next_env"
chmod 0640 "$next_env"
install -o root -g root -m 0644 "$previous_unit" "$next_unit"
verify_unit="$(mktemp --suffix=.service "$state_dir/rollback-unit.XXXXXX")"
cp -- "$previous_unit" "$verify_unit"
if ! systemd-analyze verify "$verify_unit"; then
  rm -f -- "$old_env" "$old_unit" "$next_link" "$next_env" "$next_unit" "$verify_unit"
  exit 1
fi
rm -f -- "$verify_unit"

cleanup_rollback_temps() {
  rm -f -- "$old_env" "$old_unit" "$next_link" "$next_env" "$next_unit"
  rm -f -- "$state_dir"/*.next "$state_dir"/*.restore
  rm -rf -- "$metadata_backup"
}

restore_metadata_snapshot() {
  local state_name target restore
  for state_name in previous-release previous-release.env previous-service-unit current-release; do
    target="$state_dir/$state_name"
    restore="${target}.restore"
    rm -f -- "$restore"
    if [[ -e "$metadata_backup/$state_name" ]]; then
      cp -a -- "$metadata_backup/$state_name" "$restore" || return 1
      mv -Tf "$restore" "$target" || return 1
    else
      rm -f -- "$target" || return 1
    fi
  done
}

restore_current_state() {
  local label="$1"
  trap - ERR
  set +e
  if ! stop_service; then
    echo "FATAL: failed rollback target is still running; release pointers were not restored" >&2
    return 1
  fi
  ln -sfn "$old_release" "$next_link" && mv -Tf "$next_link" "$current_link" || return 1
  cp -- "$old_env" "$next_env" || return 1
  chown root:scifigure "$next_env" || return 1
  chmod 0640 "$next_env" || return 1
  mv -f "$next_env" "$release_env" || return 1
  install -o root -g root -m 0644 "$old_unit" "$next_unit" || return 1
  mv -Tf "$next_unit" "$service_unit" || return 1
  systemctl daemon-reload || return 1
  restore_metadata_snapshot || return 1
  start_and_wait "$label"
}

transaction_active=0
handle_rollback_error() {
  local exit_code=$?
  trap - ERR
  set +e
  if (( transaction_active )); then
    restore_current_state "restored current release after rollback command failure" || true
  fi
  cleanup_rollback_temps
  exit "$exit_code"
}
trap handle_rollback_error ERR

if ! stop_service; then
  trap - ERR
  cleanup_rollback_temps
  exit 1
fi
transaction_active=1
mv -Tf "$next_unit" "$service_unit"
mv -Tf "$next_link" "$current_link"
mv -f "$next_env" "$release_env"
systemctl daemon-reload
if ! start_and_wait "rollback target"; then
  journalctl -u scifigure.service -n 100 --no-pager >&2 || true
  if restore_current_state "restored current release"; then
    echo "Rollback target failed readiness; current release restored" >&2
  else
    journalctl -u scifigure.service -n 100 --no-pager >&2 || true
    echo "FATAL: rollback target and restored current release both failed readiness" >&2
  fi
  transaction_active=0
  trap - ERR
  cleanup_rollback_temps
  exit 1
fi

printf '%s\n' "$old_release" > "${previous_file}.next"
cp -- "$old_env" "${previous_env}.next"
cp -- "$old_unit" "${previous_unit}.next"
printf '%s\n' "$target_release" > "${current_file}.next"
chmod 0600 "${previous_file}.next" "${previous_env}.next" "${previous_unit}.next"
chmod 0644 "${current_file}.next"
mv -Tf "${previous_file}.next" "$previous_file"
mv -Tf "${previous_env}.next" "$previous_env"
mv -Tf "${previous_unit}.next" "$previous_unit"
mv -Tf "${current_file}.next" "$current_file"
transaction_active=0
trap - ERR
cleanup_rollback_temps
echo "Rolled back to $target_release"
