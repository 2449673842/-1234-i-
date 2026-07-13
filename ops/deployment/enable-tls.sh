#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "enable-tls.sh must run as root" >&2
  exit 1
fi

server_name="${1:-}"
if [[ ! "$server_name" =~ ^[A-Za-z0-9.-]+$ || "$server_name" != *.* ]]; then
  echo "Usage: enable-tls.sh <public-dns-name>" >&2
  exit 2
fi

certbot certonly \
  --webroot \
  --webroot-path /var/www/scifigure-acme \
  --domain "$server_name" \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email

template=/usr/local/share/scifigure/nginx/scifigure-tls.conf.template
target=/etc/nginx/sites-available/scifigure.conf
next="$(mktemp /etc/nginx/sites-available/scifigure.conf.XXXXXX)"
sed "s/__SERVER_NAME__/${server_name}/g" "$template" > "$next"
chmod 0644 "$next"

previous="$(mktemp /etc/nginx/sites-available/scifigure.previous.XXXXXX)"
cp -- "$target" "$previous"
mv -f -- "$next" "$target"
if ! nginx -t; then
  mv -f -- "$previous" "$target"
  nginx -t
  echo "TLS Nginx configuration was rejected and restored" >&2
  exit 1
fi

rm -f -- "$previous"
systemctl reload nginx
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/20-scifigure-reload-nginx <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
nginx -t
systemctl reload nginx
EOF
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/20-scifigure-reload-nginx
systemctl enable --now certbot.timer
echo "TLS enabled for https://${server_name}"
