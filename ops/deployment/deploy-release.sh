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
state_dir=/var/lib/scifigure/deployment
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

for required in package.json package-lock.json server.ts Dockerfile.renderer renderer; do
  if [[ ! -e "$release_dir/$required" ]]; then
    echo "Release artifact is missing: $required" >&2
    exit 1
  fi
done

runuser -u scifigure -- env \
  HOME=/var/lib/scifigure \
  NODE_OPTIONS=--max-old-space-size=2048 \
  npm_config_jobs=1 \
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
  "legacyRetireObservationV1": true
}
EOF
runuser -u scifigure -- env \
  HOME=/var/lib/scifigure \
  npm_config_jobs=1 \
  npm --prefix "$release_dir" prune --omit=dev --no-audit --no-fund

scifigure_uid="$(id -u scifigure)"
docker_host="unix:///run/user/${scifigure_uid}/docker.sock"
renderer_image="scifigure-renderer:${build_id}"
renderer_debian_mirror="${SCIFIGURE_RENDERER_DEBIAN_MIRROR:-http://deb.debian.org/debian}"
renderer_security_mirror="${SCIFIGURE_RENDERER_DEBIAN_SECURITY_MIRROR:-http://deb.debian.org/debian-security}"
renderer_pip_index="${SCIFIGURE_RENDERER_PIP_INDEX_URL:-https://pypi.org/simple}"
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

install -d -m 0755 "$state_dir"
old_release="$(readlink -f "$current_link" 2>/dev/null || true)"
old_env="$(mktemp "${state_dir}/release-env.XXXXXX")"
if [[ -f "$release_env" ]]; then
  cp -- "$release_env" "$old_env"
else
  : > "$old_env"
fi

next_link="${current_link}.next"
ln -sfn "$release_dir" "$next_link"
next_env="${release_env}.next"
cat > "$next_env" <<EOF
PORT=3101
SCIFIGURE_BUILD_ID=${build_id}
SCIFIGURE_RENDERER_IMAGE=${renderer_image}
EOF
chown root:scifigure "$next_env"
chmod 0640 "$next_env"

if ! stop_service; then
  echo "Current service is still active; refusing to replace the SQLite writer" >&2
  exit 1
fi
mv -Tf "$next_link" "$current_link"
mv -f "$next_env" "$release_env"
systemctl daemon-reload
systemctl enable scifigure.service >/dev/null
if ! start_and_wait "candidate ${build_id}"; then
  journalctl -u scifigure.service -n 100 --no-pager >&2 || true
  if ! stop_service; then
    echo "FATAL: failed candidate is still running; release pointers were not restored" >&2
    rm -f -- "$old_env"
    exit 1
  fi
  if [[ -n "$old_release" && -r "$old_release/dist/server.cjs" ]]; then
    ln -sfn "$old_release" "$next_link"
    mv -Tf "$next_link" "$current_link"
    if [[ -s "$old_env" ]]; then
      cp -- "$old_env" "$release_env"
      chown root:scifigure "$release_env"
      chmod 0640 "$release_env"
    fi
    if start_and_wait "restored previous release"; then
      echo "Candidate failed readiness; previous release restored: $old_release" >&2
    else
      journalctl -u scifigure.service -n 100 --no-pager >&2 || true
      echo "FATAL: candidate and previous release both failed readiness" >&2
    fi
  else
    echo "Initial release failed readiness; no previous release existed" >&2
  fi
  rm -f -- "$old_env"
  exit 1
fi

if [[ -n "$old_release" && -r "$old_release/dist/server.cjs" ]]; then
  printf '%s\n' "$old_release" > "$state_dir/previous-release"
  cp -- "$old_env" "$state_dir/previous-release.env"
  chmod 0600 "$state_dir/previous-release" "$state_dir/previous-release.env"
fi
printf '%s\n' "$release_dir" > "$state_dir/current-release"
chmod 0644 "$state_dir/current-release"
rm -f -- "$old_env"

echo "Deployed ${build_id}; one SciFigure instance is active"
