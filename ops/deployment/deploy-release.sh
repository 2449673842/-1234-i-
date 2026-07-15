#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "deploy-release.sh must run as root" >&2
  exit 1
fi

artifact="${1:-}"
build_id="${2:-}"
if [[ ! -f "$artifact" || ! "$build_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$ ]]; then
  echo "Usage: deploy-release.sh <source.tar.gz> <immutable-build-id>" >&2
  exit 2
fi

artifact="$(readlink -f "$artifact")"
release_root=/opt/scifigure/releases
release_dir="${release_root}/${build_id}"
current_link=/opt/scifigure/current
release_env=/etc/scifigure/release.env
service_unit=/etc/systemd/system/scifigure.service
deploy_tool=/usr/local/sbin/scifigure-deploy-release
rollback_tool=/usr/local/sbin/scifigure-rollback
state_dir=/var/lib/scifigure/deployment
previous_file="$state_dir/previous-release"
previous_env="$state_dir/previous-release.env"
previous_unit="$state_dir/previous-service-unit"
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

if [[ -e "$release_dir" ]]; then
  echo "Release already exists and will not be overwritten: $release_dir" >&2
  exit 1
fi

while IFS= read -r entry; do
  case "/${entry}/" in
    *'/../'*|*'/./'*|'//'*) echo "Unsafe archive entry: $entry" >&2; exit 1 ;;
  esac
  if [[ "$entry" = /* || "$entry" =~ ^[A-Za-z]: ]]; then
    echo "Absolute archive entry is forbidden: $entry" >&2
    exit 1
  fi
done < <(tar -tzf "$artifact")

install -d -o scifigure -g scifigure -m 0750 "$release_dir"
tar -xzf "$artifact" -C "$release_dir" --no-same-owner --no-same-permissions
chown -R scifigure:scifigure "$release_dir"

for required in package.json package-lock.json server.ts Dockerfile.renderer renderer ops/systemd/scifigure.service ops/deployment/deploy-release.sh ops/deployment/rollback.sh; do
  if [[ ! -e "$release_dir/$required" ]]; then
    echo "Release artifact is missing: $required" >&2
    exit 1
  fi
done
bash -n "$release_dir/ops/deployment/deploy-release.sh" "$release_dir/ops/deployment/rollback.sh"

build_env="${SCIFIGURE_BUILD_ENV_FILE:-/etc/scifigure/build.env}"
if [[ -r "$build_env" ]]; then
  if [[ "$(stat -c '%u' "$build_env")" != "0" ]] || [[ -n "$(find "$build_env" -prune -perm /022 -print -quit)" ]]; then
    echo "Build environment must be root-owned and not group/world-writable: $build_env" >&2
    exit 1
  fi
  while IFS='=' read -r mirror_key mirror_value || [[ -n "$mirror_key" ]]; do
    if [[ -z "$mirror_key" || "$mirror_key" == \#* ]]; then
      continue
    fi
    if [[ -z "$mirror_value" || "$mirror_key" =~ [[:space:]] || "$mirror_value" =~ [[:space:]] ]]; then
      echo "Invalid build environment entry: $mirror_key" >&2
      exit 1
    fi
    case "$mirror_key" in
      SCIFIGURE_NPM_REGISTRY|SCIFIGURE_RENDERER_DEBIAN_MIRROR|SCIFIGURE_RENDERER_DEBIAN_SECURITY_MIRROR|SCIFIGURE_RENDERER_PIP_INDEX_URL|SCIFIGURE_UBUNTU_APT_MIRROR|SCIFIGURE_DOCKER_APT_BASE_URL|SCIFIGURE_DOCKER_REGISTRY_MIRROR)
        export "$mirror_key=$mirror_value"
        ;;
      *)
        echo "Unsupported build environment key: $mirror_key" >&2
        exit 1
        ;;
    esac
  done < "$build_env"
fi
npm_registry="${SCIFIGURE_NPM_REGISTRY:-https://registry.npmmirror.com}"

runuser -u scifigure -- env \
  HOME=/var/lib/scifigure \
  NODE_OPTIONS=--max-old-space-size=2048 \
  npm_config_jobs=1 \
  npm_config_registry="$npm_registry" \
  npm --prefix "$release_dir" ci --no-audit --no-fund
runuser -u scifigure -- env \
  HOME=/var/lib/scifigure \
  NODE_OPTIONS=--max-old-space-size=2048 \
  VITE_SCIFIGURE_TARGET_RESOLVER_SHADOW=1 \
  VITE_SCIFIGURE_PROPERTY_DESCRIPTOR_V1=1 \
  VITE_SCIFIGURE_PROPERTY_INSPECTOR_V2=1 \
  VITE_SCIFIGURE_FONT_TARGET_RESOLVER_V2=1 \
  VITE_SCIFIGURE_FONT_CONTROLS_V2=1 \
  VITE_SCIFIGURE_COMPONENT_TARGET_RESOLVER_V2=1 \
  VITE_SCIFIGURE_COMPONENT_CONTROLS_V2=1 \
  VITE_SCIFIGURE_PALETTE_TARGET_RESOLVER_V2=1 \
  VITE_SCIFIGURE_PALETTE_CONTROLS_V2=1 \
  VITE_SCIFIGURE_LAYOUT_CONTROLS_V2=1 \
  VITE_SCIFIGURE_LEGACY_RETIRE_OBSERVABILITY=1 \
  VITE_SCIFIGURE_STAGING_BUILD_ID="$build_id" \
  npm --prefix "$release_dir" run build
cat > "$release_dir/dist/unified-editing-build.json" <<EOF
{
  "kind": "unified-editing-production",
  "buildId": "${build_id}",
  "propertyInspectorV2": true,
  "fontResolverV2": true,
  "fontControlsV2": true,
  "componentResolverV2": true,
  "componentControlsV2": true,
  "paletteResolverV2": true,
  "paletteControlsV2": true,
  "layoutControlsV2": true,
  "adminConsole": true,
  "legacyRetireObservationV1": true
}
EOF
runuser -u scifigure -- env \
  HOME=/var/lib/scifigure \
  npm_config_jobs=1 \
  npm_config_registry="$npm_registry" \
  npm --prefix "$release_dir" prune --omit=dev --no-audit --no-fund

scifigure_uid="$(id -u scifigure)"
docker_host="unix:///run/user/${scifigure_uid}/docker.sock"
renderer_image="scifigure-renderer:${build_id}"
renderer_debian_mirror="${SCIFIGURE_RENDERER_DEBIAN_MIRROR:-https://mirrors.aliyun.com/debian}"
renderer_security_mirror="${SCIFIGURE_RENDERER_DEBIAN_SECURITY_MIRROR:-https://mirrors.aliyun.com/debian-security}"
renderer_pip_index="${SCIFIGURE_RENDERER_PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple}"
runuser -u scifigure -- env \
  HOME=/var/lib/scifigure \
  XDG_RUNTIME_DIR="/run/user/${scifigure_uid}" \
  DOCKER_HOST="$docker_host" \
  docker build \
    --file "$release_dir/Dockerfile.renderer" \
    --tag "$renderer_image" \
    --build-arg "DEBIAN_MIRROR=${renderer_debian_mirror}" \
    --build-arg "DEBIAN_SECURITY_MIRROR=${renderer_security_mirror}" \
    --build-arg "PIP_INDEX_URL=${renderer_pip_index}" \
    "$release_dir"

chown -R root:scifigure "$release_dir"
find "$release_dir" -type d -exec chmod 0750 {} +
find "$release_dir" -type f -exec chmod 0640 {} +
find "$release_dir/node_modules/.bin" -type f -exec chmod 0750 {} + 2>/dev/null || true
candidate_unit="$release_dir/ops/systemd/scifigure.service"
systemd-analyze verify "$candidate_unit"

install -d -m 0755 "$state_dir"
metadata_backup="$(mktemp -d "${state_dir}/metadata-backup.XXXXXX")"
for state_name in previous-release previous-release.env previous-service-unit current-release; do
  if [[ -e "$state_dir/$state_name" ]]; then
    cp -a -- "$state_dir/$state_name" "$metadata_backup/$state_name"
  fi
done
old_release="$(readlink -f "$current_link" 2>/dev/null || true)"
old_env="$(mktemp "${state_dir}/release-env.XXXXXX")"
old_unit="$(mktemp "${state_dir}/service-unit.XXXXXX")"
old_deploy_tool="$(mktemp "${state_dir}/deploy-tool.XXXXXX")"
old_rollback_tool="$(mktemp "${state_dir}/rollback-tool.XXXXXX")"
if [[ -f "$release_env" ]]; then
  cp -- "$release_env" "$old_env"
else
  : > "$old_env"
fi
if [[ -f "$service_unit" ]]; then
  cp -- "$service_unit" "$old_unit"
else
  : > "$old_unit"
fi
if [[ -f "$deploy_tool" ]]; then
  cp -- "$deploy_tool" "$old_deploy_tool"
else
  : > "$old_deploy_tool"
fi
if [[ -f "$rollback_tool" ]]; then
  cp -- "$rollback_tool" "$old_rollback_tool"
else
  : > "$old_rollback_tool"
fi

next_link="${current_link}.next"
ln -sfn "$release_dir" "$next_link"
next_env="${release_env}.next"
next_unit="${service_unit}.next"
next_deploy_tool="${deploy_tool}.next"
next_rollback_tool="${rollback_tool}.next"
cat > "$next_env" <<EOF
PORT=3101
SCIFIGURE_BUILD_ID=${build_id}
SCIFIGURE_RENDERER_IMAGE=${renderer_image}
EOF
chown root:scifigure "$next_env"
chmod 0640 "$next_env"
install -o root -g root -m 0644 "$candidate_unit" "$next_unit"
install -o root -g root -m 0755 "$release_dir/ops/deployment/deploy-release.sh" "$next_deploy_tool"
install -o root -g root -m 0755 "$release_dir/ops/deployment/rollback.sh" "$next_rollback_tool"

cleanup_deploy_temps() {
  rm -f -- "$old_env" "$old_unit" "$old_deploy_tool" "$old_rollback_tool"
  rm -f -- "$next_link" "$next_env" "$next_unit" "$next_deploy_tool" "$next_rollback_tool"
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

restore_previous_state() {
  local label="$1"
  trap - ERR
  set +e
  if ! stop_service; then
    echo "FATAL: failed candidate is still running; release pointers were not restored" >&2
    return 1
  fi

  if [[ -n "$old_release" && -r "$old_release/dist/server.cjs" ]]; then
    ln -sfn "$old_release" "$next_link" && mv -Tf "$next_link" "$current_link" || return 1
  else
    rm -f -- "$current_link" || return 1
  fi

  if [[ -s "$old_env" ]]; then
    cp -- "$old_env" "$next_env" || return 1
    chown root:scifigure "$next_env" || return 1
    chmod 0640 "$next_env" || return 1
    mv -f "$next_env" "$release_env" || return 1
  else
    rm -f -- "$release_env" || return 1
  fi

  if [[ -s "$old_unit" ]]; then
    install -o root -g root -m 0644 "$old_unit" "$next_unit" || return 1
    mv -Tf "$next_unit" "$service_unit" || return 1
  else
    rm -f -- "$service_unit" || return 1
  fi
  if [[ -s "$old_deploy_tool" ]]; then
    install -o root -g root -m 0755 "$old_deploy_tool" "$next_deploy_tool" || return 1
    mv -Tf "$next_deploy_tool" "$deploy_tool" || return 1
  else
    rm -f -- "$deploy_tool" || return 1
  fi
  if [[ -s "$old_rollback_tool" ]]; then
    install -o root -g root -m 0755 "$old_rollback_tool" "$next_rollback_tool" || return 1
    mv -Tf "$next_rollback_tool" "$rollback_tool" || return 1
  else
    rm -f -- "$rollback_tool" || return 1
  fi
  systemctl daemon-reload || return 1
  restore_metadata_snapshot || return 1

  if [[ -n "$old_release" && -r "$old_release/dist/server.cjs" ]]; then
    start_and_wait "$label"
    return $?
  fi
  return 0
}

transaction_active=0
handle_deploy_error() {
  local exit_code=$?
  trap - ERR
  set +e
  if (( transaction_active )); then
    restore_previous_state "restored previous release after deployment command failure" || true
  fi
  cleanup_deploy_temps
  exit "$exit_code"
}
trap handle_deploy_error ERR

if ! stop_service; then
  echo "Current service is still active; refusing to replace the SQLite writer" >&2
  trap - ERR
  cleanup_deploy_temps
  exit 1
fi
transaction_active=1
mv -Tf "$next_unit" "$service_unit"
mv -Tf "$next_deploy_tool" "$deploy_tool"
mv -Tf "$next_rollback_tool" "$rollback_tool"
mv -Tf "$next_link" "$current_link"
mv -f "$next_env" "$release_env"
systemctl daemon-reload
if ! start_and_wait "candidate ${build_id}"; then
  journalctl -u scifigure.service -n 100 --no-pager >&2 || true
  if restore_previous_state "restored previous release"; then
    echo "Candidate failed readiness; previous release restored: ${old_release:-none}" >&2
  else
    journalctl -u scifigure.service -n 100 --no-pager >&2 || true
    echo "FATAL: candidate and previous release both failed readiness" >&2
  fi
  transaction_active=0
  trap - ERR
  cleanup_deploy_temps
  exit 1
fi
systemctl enable scifigure.service >/dev/null

if [[ -n "$old_release" && -r "$old_release/dist/server.cjs" ]]; then
  printf '%s\n' "$old_release" > "${previous_file}.next"
  cp -- "$old_env" "${previous_env}.next"
  cp -- "$old_unit" "${previous_unit}.next"
  chmod 0600 "${previous_file}.next" "${previous_env}.next" "${previous_unit}.next"
fi
printf '%s\n' "$release_dir" > "${current_file}.next"
chmod 0644 "${current_file}.next"
if [[ -e "${previous_file}.next" ]]; then
  mv -Tf "${previous_file}.next" "$previous_file"
  mv -Tf "${previous_env}.next" "$previous_env"
  mv -Tf "${previous_unit}.next" "$previous_unit"
fi
mv -Tf "${current_file}.next" "$current_file"
transaction_active=0
trap - ERR
cleanup_deploy_temps

echo "Deployed ${build_id}; one SciFigure instance is active"
