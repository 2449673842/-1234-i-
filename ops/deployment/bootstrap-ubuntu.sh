#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "bootstrap-ubuntu.sh must run as root" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
server_name="${1:-_}"
ubuntu_apt_mirror="${SCIFIGURE_UBUNTU_APT_MIRROR:-https://mirrors.aliyun.com/ubuntu}"
docker_apt_base="${SCIFIGURE_DOCKER_APT_BASE_URL:-https://mirrors.aliyun.com/docker-ce}"
docker_registry_mirror="${SCIFIGURE_DOCKER_REGISTRY_MIRROR:-https://docker.m.daocloud.io}"

if [[ ! -r /etc/os-release ]]; then
  echo "Unable to identify the operating system" >&2
  exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
  echo "This bootstrap is pinned to Ubuntu 24.04; found ${ID:-unknown} ${VERSION_ID:-unknown}" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
for ubuntu_sources in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
  if [[ -f "$ubuntu_sources" ]]; then
    sed -i -E \
      -e "s|https?://archive.ubuntu.com/ubuntu/?|${ubuntu_apt_mirror%/}/|g" \
      -e "s|https?://security.ubuntu.com/ubuntu/?|${ubuntu_apt_mirror%/}/|g" \
      "$ubuntu_sources"
  fi
done
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg nginx certbot python3-certbot-nginx \
  git sqlite3 rsync restic jq acl uidmap dbus-user-session \
  slirp4netns fuse-overlayfs tar xz-utils ufw

install -d -m 0755 /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
fi
cat > /etc/apt/sources.list.d/nodesource.list <<'EOF'
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main
EOF

if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
  curl -fsSL "${docker_apt_base}/linux/ubuntu/gpg" \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
fi
chmod a+r /etc/apt/keyrings/docker.gpg
cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] ${docker_apt_base}/linux/ubuntu ${VERSION_CODENAME} stable
EOF

apt-get update
apt-get install -y --no-install-recommends \
  nodejs docker-ce docker-ce-cli containerd.io \
  docker-ce-rootless-extras docker-buildx-plugin

if [[ "${SCIFIGURE_DISABLE_ROOTFUL_DOCKER:-0}" == "1" ]]; then
  if docker --host unix:///var/run/docker.sock ps -q 2>/dev/null | grep -q .; then
    echo "Rootful Docker has running containers; refusing to disable it" >&2
    exit 1
  fi
  systemctl disable --now docker.service docker.socket containerd.service >/dev/null 2>&1 || true
fi

if ! id scifigure >/dev/null 2>&1; then
  useradd --create-home --home-dir /var/lib/scifigure --shell /bin/bash scifigure
  passwd --lock scifigure >/dev/null
fi

install -d -o scifigure -g scifigure -m 0700 /var/lib/scifigure
install -d -o scifigure -g scifigure -m 0700 /var/lib/scifigure/observability
install -d -o scifigure -g scifigure -m 0750 /srv/scifigure/data
install -d -o root -g scifigure -m 0750 /opt/scifigure/releases /opt/scifigure/slots
install -d -o root -g scifigure -m 0750 /etc/scifigure
install -d -m 0755 /etc/nginx/scifigure /var/www/scifigure-acme
install -d -m 0755 /var/lib/scifigure/deployment

if ! swapon --show=NAME --noheadings | grep -q .; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 4G /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
if ! grep -q '^/swapfile ' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi

scifigure_uid="$(id -u scifigure)"
loginctl enable-linger scifigure
systemctl start "user@${scifigure_uid}.service"
docker_config_dir=/var/lib/scifigure/.config/docker
if [[ ! -f "$docker_config_dir/daemon.json" ]]; then
  install -d -o scifigure -g scifigure -m 0700 "$docker_config_dir"
  cat > "$docker_config_dir/daemon.json" <<EOF
{
  "registry-mirrors": ["${docker_registry_mirror}"]
}
EOF
  chown scifigure:scifigure "$docker_config_dir/daemon.json"
  chmod 0600 "$docker_config_dir/daemon.json"
fi
if [[ ! -S "/run/user/${scifigure_uid}/docker.sock" ]]; then
  runuser -u scifigure -- env \
    HOME=/var/lib/scifigure \
    XDG_RUNTIME_DIR="/run/user/${scifigure_uid}" \
    dockerd-rootless-setuptool.sh install
fi
runuser -u scifigure -- env \
  HOME=/var/lib/scifigure \
  XDG_RUNTIME_DIR="/run/user/${scifigure_uid}" \
  systemctl --user enable --now docker.service

install -o root -g root -m 0644 "$repo_root/ops/systemd/scifigure.service" /etc/systemd/system/scifigure.service
install -o root -g root -m 0755 "$repo_root/ops/deployment/rollback.sh" /usr/local/sbin/scifigure-rollback
install -o root -g root -m 0755 "$repo_root/ops/deployment/deploy-release.sh" /usr/local/sbin/scifigure-deploy-release
install -o root -g root -m 0755 "$repo_root/ops/deployment/enable-tls.sh" /usr/local/sbin/scifigure-enable-tls
install -d -o root -g root -m 0755 /usr/local/share/scifigure/nginx
install -o root -g root -m 0644 "$repo_root/ops/nginx/scifigure-tls.conf.template" \
  /usr/local/share/scifigure/nginx/scifigure-tls.conf.template

if [[ ! -f /etc/scifigure/common.env ]]; then
  sed "s/__SCIFIGURE_UID__/${scifigure_uid}/g" \
    "$repo_root/ops/env/scifigure-common.env.example" > /etc/scifigure/common.env
  chown root:scifigure /etc/scifigure/common.env
  chmod 0640 /etc/scifigure/common.env
fi

if [[ ! -f /etc/scifigure/release.env ]]; then
  install -o root -g scifigure -m 0640 "$repo_root/ops/env/scifigure-release.env.example" /etc/scifigure/release.env
fi

if [[ ! -f /etc/scifigure/build.env ]]; then
  install -o root -g scifigure -m 0640 "$repo_root/ops/env/scifigure-build.env.example" /etc/scifigure/build.env
fi

sed "s/__SERVER_NAME__/${server_name}/g" \
  "$repo_root/ops/nginx/scifigure-bootstrap.conf.template" > /etc/nginx/sites-available/scifigure.conf
ln -sfn /etc/nginx/sites-available/scifigure.conf /etc/nginx/sites-enabled/scifigure.conf
rm -f /etc/nginx/sites-enabled/default

if [[ "${SCIFIGURE_ENABLE_UFW:-0}" == "1" ]]; then
  mapfile -t ssh_ports < <(sshd -T | awk '$1 == "port" { print $2 }' | sort -u)
  if (( ${#ssh_ports[@]} == 0 )); then
    echo "Unable to determine SSH port; refusing to enable UFW" >&2
    exit 1
  fi
  for ssh_port in "${ssh_ports[@]}"; do
    ufw allow "${ssh_port}/tcp"
  done
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
else
  echo "UFW was not enabled; set SCIFIGURE_ENABLE_UFW=1 after cloud firewall review"
fi

systemctl daemon-reload
nginx -t
systemctl enable --now nginx

echo "SciFigure host bootstrap completed"
echo "service user uid: ${scifigure_uid}"
echo "server name: ${server_name}"
