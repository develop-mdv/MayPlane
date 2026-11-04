#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
unset NODE_OPTIONS NODE_PATH

PREFIX=/opt/mayplane/panel
DATA=/var/lib/mayplane
CONFIG=/etc/mayplane
CADDY_VERSION=2.11.8
MODE='' ADDRESS='' EMAIL='' LOGIN=admin PLAN=0 PRINT_CADDY=0 UPDATE=0
fail() { printf 'MayPlane: %s\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --mode|--address|--email|--username) (($# >= 2)) || fail "Нет значения $1"; case "$1" in --mode) MODE=$2;; --address) ADDRESS=$2;; --email) EMAIL=$2;; --username) LOGIN=$2;; esac; shift 2;;
    --plan) PLAN=1; shift;;
    --print-caddy) PRINT_CADDY=1; shift;;
    --update) UPDATE=1; shift;;
    --help) printf 'sudo bash scripts/install.sh [--mode local|ip|domain] [--address ADDRESS] [--email EMAIL] [--username LOGIN] [--update]\n--plan / --print-caddy: только показать конфигурацию, без установки\n'; exit 0;;
    *) fail "Неизвестный параметр: $1";;
  esac
done
prompt() { [[ -r /dev/tty ]] || fail 'Укажите --mode и --address для установки без терминала'; read -r -p "$1" "$2" </dev/tty; }
if [[ -z "$MODE" && $UPDATE = 1 && -r "$CONFIG/mayplane.env" ]]; then
  MODE=$(sed -n 's/^MAYPLANE_ACCESS_MODE=//p' "$CONFIG/mayplane.env")
  prior_url=$(sed -n 's/^MAYPLANE_PUBLIC_URL=//p' "$CONFIG/mayplane.env")
  ADDRESS=${prior_url#https://}; ADDRESS=${ADDRESS#[}; ADDRESS=${ADDRESS%]}
  EMAIL=$(sed -n 's/^MAYPLANE_ACME_EMAIL=//p' "$CONFIG/mayplane.env")
fi
if [[ -z "$MODE" ]]; then
  if ((PLAN || PRINT_CADDY)); then MODE=local; else
    printf 'MayPlane: выберите доступ\n1) Только локально (сеть не открывается)\n2) Публичный IP + HTTPS\n3) Домен + HTTPS\n'
    prompt 'Режим [1]: ' choice
    case "${choice:-1}" in 1) MODE=local;; 2) MODE=ip;; 3) MODE=domain;; *) fail 'Выберите 1, 2 или 3';; esac
  fi
fi
[[ "$MODE" =~ ^(local|ip|domain)$ ]] || fail 'Режим должен быть local, ip или domain'
[[ "$LOGIN" =~ ^[a-zA-Z0-9_.@-]{3,64}$ ]] || fail 'Некорректный логин'
if [[ "$MODE" != local && -z "$ADDRESS" ]]; then prompt 'Публичный IP или домен без https:// и порта: ' ADDRESS; fi
if [[ "$MODE" = domain ]]; then
  [[ "$ADDRESS" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && "$ADDRESS" == *.* && "$ADDRESS" != *..* && ${#ADDRESS} -le 253 ]] || fail 'Некорректный домен'
elif [[ "$MODE" = ip ]]; then
  [[ "$ADDRESS" =~ ^[a-fA-F0-9:.]+$ && "$ADDRESS" == *[.:]* && ${#ADDRESS} -le 45 ]] || fail 'Некорректный IP'
fi
[[ -z "$EMAIL" || "$EMAIL" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$ ]] || fail 'Некорректный email ACME'
PUBLIC_URL=http://127.0.0.1:8788
SITE=$ADDRESS
if [[ "$MODE" != local ]]; then
  [[ "$ADDRESS" == *:* ]] && SITE="[$ADDRESS]"
  PUBLIC_URL="https://$SITE"
fi
caddyfile() {
  [[ "$MODE" != local ]] || return 0
  printf '{\n  admin off\n'
  [[ -z "$EMAIL" ]] || printf '  email %s\n' "$EMAIL"
  [[ "$MODE" != ip ]] || printf '  default_sni %s\n' "$ADDRESS"
  printf '}\n%s {\n' "$PUBLIC_URL"
  if [[ "$MODE" = ip ]]; then
    printf '  tls {\n    issuer acme {\n      dir https://acme-v02.api.letsencrypt.org/directory\n      profile shortlived\n    }\n  }\n'
  fi
  printf '  encode zstd gzip\n  request_body {\n    max_size 1MB\n  }\n  reverse_proxy 127.0.0.1:8788\n}\n'
}
if ((PRINT_CADDY)); then caddyfile; exit 0; fi
if ((PLAN)); then printf '{"mode":"%s","address":"%s","url":"%s","bind":"127.0.0.1","port":8788,"frontendPort":8789,"automaticTls":%s,"service":"mayplane.service","data":"%s"}\n' "$MODE" "$ADDRESS" "$PUBLIC_URL" "$([[ "$MODE" = local ]] && echo false || echo true)" "$DATA"; exit 0; fi
[[ $(uname -s) = Linux && -d /run/systemd/system ]] || fail 'Установщик рассчитан на Linux с systemd. Для локального запуска используйте npm ci && npm run runner:setup && npm run build && npm start.'
[[ $EUID = 0 ]] || fail 'Запустите установщик через sudo'
source /etc/os-release
[[ "${ID:-}" =~ ^(ubuntu|debian)$ || " ${ID_LIKE:-} " == *' debian '* ]] || fail 'Поддерживаются Ubuntu и Debian'
for unit in mayplane mayplane-proxy; do
  if [[ -f "/etc/systemd/system/$unit.service" ]]; then grep -qF '# Managed by MayPlane installer' "/etc/systemd/system/$unit.service" || fail "Служба $unit уже существует и не принадлежит установщику"; fi
done
check_port() {
  if command -v ss >/dev/null && [[ -n $(ss -H -ltn "sport = :$1") ]]; then
    systemctl is-active --quiet "$2" && [[ -f "/etc/systemd/system/$2.service" ]] && grep -qF '# Managed by MayPlane installer' "/etc/systemd/system/$2.service" || fail "Порт $1 уже занят. Другие службы не остановлены. Освободите порт или используйте локальный режим со своим HTTPS-прокси."
  fi
}
check_port 8788 mayplane; check_port 8789 mayplane
if [[ "$MODE" != local ]]; then check_port 80 mayplane-proxy; check_port 443 mayplane-proxy; fi
printf 'Подготовка MayPlane (%s). Посторонние сайты и настройки SSH не изменяются.\n' "$MODE"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl git xz-utils tar iproute2
check_port 8788 mayplane; check_port 8789 mayplane
if [[ "$MODE" != local ]]; then check_port 80 mayplane-proxy; check_port 443 mayplane-proxy; fi
case "$(uname -m)" in x86_64) NODE_ARCH=x64; CADDY_ARCH=amd64;; aarch64|arm64) NODE_ARCH=arm64; CADDY_ARCH=arm64;; *) fail 'Поддерживаются amd64 и arm64';; esac
install -d -o root -g root -m 0755 "$PREFIX" "$PREFIX/releases" "$PREFIX/runtime" "$PREFIX/tools" "$CONFIG"
WORK=$(mktemp -d /tmp/mayplane-install.XXXXXXXX)
CREDENTIALS=''
old_current=''; old_node=''; was_active=0; proxy_active=0
[[ ! -L "$PREFIX/current" ]] || old_current=$(readlink "$PREFIX/current")
[[ ! -L "$PREFIX/node" ]] || old_node=$(readlink "$PREFIX/node")
[[ ! -f "$CONFIG/mayplane.env" ]] || cp -p "$CONFIG/mayplane.env" "$WORK/previous.env"
[[ ! -f "$CONFIG/Caddyfile" ]] || cp -p "$CONFIG/Caddyfile" "$WORK/previous.Caddyfile"
for unit in mayplane mayplane-proxy; do
  [[ ! -f "/etc/systemd/system/$unit.service" ]] || cp -p "/etc/systemd/system/$unit.service" "$WORK/$unit.service"
done
systemctl is-active --quiet mayplane && was_active=1 || true
systemctl is-active --quiet mayplane-proxy && proxy_active=1 || true
finish() {
  result=$?
  set +e
  if ((result && was_active)) && [[ -f "$WORK/previous.env" && "$old_current" == "$PREFIX/releases/"* ]]; then
    install -o root -g mayplane -m 0640 "$WORK/previous.env" "$CONFIG/mayplane.env"
    ln -sfn "$old_current" "$PREFIX/current"
    [[ "$old_node" != "$PREFIX/runtime/"* ]] || ln -sfn "$old_node" "$PREFIX/node"
    [[ ! -f "$WORK/previous.Caddyfile" ]] || install -m 0644 "$WORK/previous.Caddyfile" "$CONFIG/Caddyfile"
    for unit in mayplane mayplane-proxy; do
      [[ ! -f "$WORK/$unit.service" ]] || install -m 0644 "$WORK/$unit.service" "/etc/systemd/system/$unit.service"
    done
    systemctl daemon-reload
    systemctl restart mayplane || true
    if ((proxy_active)); then systemctl enable --now mayplane-proxy || true; systemctl restart mayplane-proxy || true; fi
    printf 'Возвращена предыдущая версия панели. База не откатывалась; резервная копия сохранена.\n' >&2
  fi
  if [[ -n "$CREDENTIALS" ]]; then printf '%s\n' "$CREDENTIALS"; fi
  if ((result)); then printf 'Установка не завершена. Диагностика: journalctl -u mayplane -u mayplane-proxy -n 80. Ключ базы не сбрасывался.\n' >&2; fi
  case "$WORK" in /tmp/mayplane-install.*) rm -rf -- "$WORK";; esac
  exit "$result"
}
trap finish EXIT
fetch() { curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --connect-timeout 15 "$1" -o "$2"; }
fetch https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt "$WORK/node-checksums"
NODE_FILE=$(awk -v arch="$NODE_ARCH" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2;exit}' "$WORK/node-checksums")
[[ "$NODE_FILE" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || fail 'Не удалось определить официальный Node.js 24'
NODE_DIR="$PREFIX/runtime/${NODE_FILE%.tar.xz}"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  fetch "https://nodejs.org/dist/latest-v24.x/$NODE_FILE" "$WORK/$NODE_FILE"
  (cd "$WORK"; grep -F " $NODE_FILE" node-checksums | sha256sum --check --status) || fail 'Контрольная сумма Node.js не совпала'
  install -d -m 0755 "$NODE_DIR"
  tar -xJf "$WORK/$NODE_FILE" --strip-components=1 --no-same-owner -C "$NODE_DIR"
fi
NODE="$NODE_DIR/bin/node"
export PATH="$NODE_DIR/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if [[ "$MODE" != local ]]; then
  "$NODE" --input-type=module -e '
    import {isIP} from "node:net"; import {lookup} from "node:dns/promises";
    const [mode,address]=process.argv.slice(1);
    const publicIp = ip => {if(isIP(ip)===4) {const [a,b,c]=ip.split(".").map(Number);return a>0&&a<224&&a!==10&&a!==127&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0))&&!(a===192&&b===0&&c===2)&&!(a===203&&b===0&&c===113)&&!(a===100&&b>=64&&b<=127)&&!(a===198&&(b===18||b===19||b===51&&c===100));}return isIP(ip)===6&&/^[23]/.test(ip)&&!/^2001:db8:/i.test(ip);};
    if(mode==="ip"&&!publicIp(address)) throw new Error("Для публичного IP нужен глобально доступный IPv4/IPv6. Для локальных адресов выберите local.");
    if(mode==="domain") {if(address.split(".").some(l=>!l||l.length>63||l.startsWith("-")||l.endsWith("-"))) throw new Error("Некорректные метки домена");const records=await lookup(address,{all:true});if(!records.length||records.some(r=>!publicIp(r.address)))throw new Error("Настройте публичные A/AAAA записи домена перед установкой.");}
  ' "$MODE" "$ADDRESS"
fi
if ! id mayplane >/dev/null 2>&1; then useradd --system --user-group --home-dir "$DATA" --shell /usr/sbin/nologin mayplane; fi
[[ "$(getent passwd mayplane | cut -d: -f6)" = "$DATA" ]] || fail 'Пользователь mayplane уже существует с другим домашним каталогом'
[[ $(id -u mayplane) != 0 ]] || fail 'Пользователь mayplane не должен иметь UID root'
install -d -o mayplane -g mayplane -m 0700 "$DATA" "$DATA/projects" "$DATA/backups" /var/cache/mayplane
release="$PREFIX/releases/$(date -u +%Y%m%dT%H%M%S)-$RANDOM"
install -d -o mayplane -g mayplane -m 0755 "$release"
source_root=''
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); fi
if [[ -n "$source_root" && -d "$source_root/.git" && $UPDATE = 0 ]]; then
  git -c safe.directory="$source_root" -c core.fsmonitor=false -C "$source_root" archive --format=tar HEAD | runuser -u mayplane -- env -i HOME="$DATA" USER=mayplane PATH="$PATH" tar -xf - --no-same-owner -C "$release"
else
  runuser -u mayplane -- env -i HOME="$DATA" USER=mayplane PATH="$PATH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.hooksPath=/dev/null clone --depth 1 --branch main -- https://github.com/develop-mdv/MayPlane.git "$release"
fi
[[ -f "$release/runner/owner-auth.mjs" && -f "$release/runner/start.mjs" ]] || fail 'В выбранной версии нет self-hosted установки. Сначала опубликуйте изменения в репозитории.'
runuser -u mayplane -- env -i HOME="$DATA" USER=mayplane PATH="$PATH" XDG_CACHE_HOME=/var/cache/mayplane npm --prefix "$release" ci --no-audit --no-fund
(cd "$release"; runuser -u mayplane -- env -i HOME="$DATA" USER=mayplane PATH="$PATH" XDG_CACHE_HOME=/var/cache/mayplane npm run build)
chown -hR root:root "$release"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod a+rX {} +
key=''
if [[ -f "$CONFIG/mayplane.env" ]]; then key=$(sed -n 's/^MAYPLANE_ENCRYPTION_KEY=//p' "$CONFIG/mayplane.env"); fi
if [[ -z "$key" && -e "$DATA/mayplane.sqlite" ]]; then fail 'Есть база без сохранённого ключа. Восстановите конфигурацию; новый ключ не создан.'; fi
[[ -n "$key" ]] || key=$("$NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
[[ "$key" =~ ^[a-fA-F0-9]{64}$ ]] || fail 'Некорректный существующий ключ шифрования'
if [[ -e "$DATA/mayplane.sqlite" ]]; then
  runuser -u mayplane -- "$NODE" --input-type=module -e 'import {DatabaseSync,backup} from "node:sqlite";import {chmodSync} from "node:fs";const db=new DatabaseSync(process.argv[1],{readOnly:true});const out=process.argv[2];await backup(db,out);db.close();chmodSync(out,0o600);' "$DATA/mayplane.sqlite" "$DATA/backups/before-install-$(date -u +%Y%m%dT%H%M%S).sqlite"
fi
if [[ -f "$CONFIG/mayplane.env" ]]; then
  sed -E '/^(MAYPLANE_(ENCRYPTION_KEY|DATA_DIR|ACCESS_MODE|PUBLIC_URL|ACME_EMAIL|TLS_MANAGED|TRUST_PROXY)|HOST|PORT|MAYPLANE_WEB_PORT)=/d' "$CONFIG/mayplane.env" > "$WORK/mayplane.env"
fi
cat >> "$WORK/mayplane.env" <<EOF
MAYPLANE_ENCRYPTION_KEY=$key
MAYPLANE_DATA_DIR=$DATA
MAYPLANE_ACCESS_MODE=$MODE
MAYPLANE_PUBLIC_URL=$PUBLIC_URL
MAYPLANE_ACME_EMAIL=$EMAIL
MAYPLANE_TLS_MANAGED=$([[ "$MODE" = local ]] && echo false || echo true)
MAYPLANE_TRUST_PROXY=$([[ "$MODE" = local ]] && echo false || echo true)
HOST=127.0.0.1
PORT=8788
MAYPLANE_WEB_PORT=8789
EOF
install -o root -g mayplane -m 0640 "$WORK/mayplane.env" "$CONFIG/mayplane.env"
CREDENTIALS=$(cd "$release"; runuser -u mayplane -- env -i HOME="$DATA" USER=mayplane PATH="$PATH" MAYPLANE_ENV_FILE="$CONFIG/mayplane.env" "$NODE" runner/setup.mjs --username "$LOGIN")
[[ ! -e "$PREFIX/current" || -L "$PREFIX/current" ]] || fail 'Путь current уже занят обычным каталогом'
ln -sfn "$release" "$PREFIX/current"
ln -sfn "$NODE_DIR" "$PREFIX/node"
cat > /etc/systemd/system/mayplane.service <<EOF
# Managed by MayPlane installer
[Unit]
Description=MayPlane personal server panel
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=mayplane
Group=mayplane
WorkingDirectory=$PREFIX/current
EnvironmentFile=$CONFIG/mayplane.env
Environment=NODE_ENV=production
Environment=HOME=$DATA
Environment=PATH=$PREFIX/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=XDG_CACHE_HOME=/var/cache/mayplane
ExecStart=$PREFIX/node/bin/node runner/start.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
KillMode=mixed
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA /var/cache/mayplane
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
[Install]
WantedBy=multi-user.target
EOF
if [[ "$MODE" != local ]]; then
  caddy_dir="$PREFIX/tools/caddy-$CADDY_VERSION"
  if [[ ! -x "$caddy_dir/caddy" ]]; then
    caddy_file="caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz"
    fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_checksums.txt" "$WORK/caddy-checksums"
    fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/$caddy_file" "$WORK/$caddy_file"
    (cd "$WORK"; grep -F " $caddy_file" caddy-checksums | sha512sum --check --status) || fail 'Контрольная сумма SHA-512 Caddy не совпала'
    install -d -m 0755 "$caddy_dir"
    tar -xzf "$WORK/$caddy_file" --no-same-owner -C "$caddy_dir" caddy
    chmod 0755 "$caddy_dir/caddy"
  fi
  caddyfile > "$WORK/Caddyfile"
  "$caddy_dir/caddy" validate --adapter caddyfile --config "$WORK/Caddyfile"
  install -o root -g root -m 0644 "$WORK/Caddyfile" "$CONFIG/Caddyfile"
  if ! id mayplane-proxy >/dev/null 2>&1; then useradd --system --user-group --home-dir /var/lib/mayplane-proxy --shell /usr/sbin/nologin mayplane-proxy; fi
  [[ "$(getent passwd mayplane-proxy | cut -d: -f6)" = /var/lib/mayplane-proxy && $(id -u mayplane-proxy) != 0 ]] || fail 'Пользователь mayplane-proxy уже существует с несовместимой конфигурацией'
  install -d -o mayplane-proxy -g mayplane-proxy -m 0700 /var/lib/mayplane-proxy
  cat > /etc/systemd/system/mayplane-proxy.service <<EOF
# Managed by MayPlane installer
[Unit]
Description=MayPlane HTTPS and automatic certificate renewal
After=network-online.target mayplane.service
Wants=network-online.target
[Service]
User=mayplane-proxy
Group=mayplane-proxy
Environment=HOME=/var/lib/mayplane-proxy
ExecStart=$caddy_dir/caddy run --adapter caddyfile --config $CONFIG/Caddyfile
Restart=on-failure
RestartSec=5
UMask=0077
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/mayplane-proxy
[Install]
WantedBy=multi-user.target
EOF
  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow 80/tcp comment 'MayPlane ACME'; ufw allow 443/tcp comment 'MayPlane HTTPS'; fi
fi
systemctl daemon-reload
systemctl enable mayplane.service
systemctl restart mayplane.service
if [[ "$MODE" != local ]]; then systemctl enable mayplane-proxy.service; systemctl restart mayplane-proxy.service; elif [[ -f /etc/systemd/system/mayplane-proxy.service ]]; then systemctl disable --now mayplane-proxy.service; fi
printf 'Ожидаем готовность панели%s…\n' "$([[ "$MODE" = local ]] || printf ' и доверенный HTTPS-сертификат')"
ready=0
for attempt in $(seq 1 60); do
  if [[ "$MODE" = local ]]; then
    if curl -fsS --max-time 3 "$PUBLIC_URL/healthz" >/dev/null 2>&1; then ready=1;break;fi
  else
    if curl -fsS --max-time 4 --connect-to ::127.0.0.1:443 "$PUBLIC_URL/healthz" >/dev/null 2>&1; then ready=1;break;fi
  fi
  sleep 3
done
((ready)) || fail 'Не удалось подтвердить готовность. Для IP/домена проверьте доступность 80/443 и правильность всех A/AAAA записей. Небезопасный HTTP не включён.'
printf '\nMayPlane готов: %s\n' "$PUBLIC_URL"
[[ "$MODE" = local ]] || printf 'Caddy автоматически получает и продлевает сертификаты. Хранилище: /var/lib/mayplane-proxy.\n'
printf 'Обновление: sudo bash %s/current/scripts/install.sh --update\nДиагностика: sudo -u mayplane env MAYPLANE_ENV_FILE=%s/mayplane.env %s/node/bin/node %s/current/runner/doctor.mjs\n' "$PREFIX" "$CONFIG" "$PREFIX" "$PREFIX"
