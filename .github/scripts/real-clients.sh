#!/usr/bin/env bash
# Starts the real download clients that
# server/api/downloadclients/realClients.test.ts checks Seerr AI's code
# against, on this machine's network, each with the address and password
# the checks use: Deluge, qBittorrent, Transmission, SABnzbd and NZBGet in
# their current linuxserver.io images, and rTorrent behind nginx at /RPC2
# (as ruTorrent serves it). Writes what the checks need to know to
# $GITHUB_ENV (or prints it, run by hand).
set -euo pipefail

ROOT=${REAL_CLIENTS_ROOT:-/tmp/real-clients}
OUT=${GITHUB_ENV:-/dev/stdout}
U=$(id -u)
G=$(id -g)
mkdir -p "$ROOT"
for client in deluge qbittorrent transmission sabnzbd nzbget; do
  mkdir -p "$ROOT/$client/config" "$ROOT/$client/downloads"
done
mkdir -p "$ROOT/rtorrent/session" "$ROOT/rtorrent/downloads" "$ROOT/rtorrent/nginx/tmp"

run() {
  local name=$1 image=$2
  shift 2
  docker run -d --name "real-$name" --network host \
    -e PUID="$U" -e PGID="$G" -e TZ=Etc/UTC \
    -v "$ROOT/$name/config:/config" -v "$ROOT/$name/downloads:/downloads" \
    "$@" "$image" >/dev/null
  echo "REAL_${name^^}_PATHS=/downloads=$ROOT/$name/downloads" >>"$OUT"
}

# qBittorrent signs in with a password it's given, not the one it makes up.
python3 - "$ROOT/qbittorrent/config" <<'PY'
import base64, hashlib, os, sys
salt = os.urandom(16)
key = hashlib.pbkdf2_hmac('sha512', b'adminadmin', salt, 100000, 64)
folder = os.path.join(sys.argv[1], 'qBittorrent')
os.makedirs(folder, exist_ok=True)
with open(os.path.join(folder, 'qBittorrent.conf'), 'w') as f:
    f.write(f"""[LegalNotice]
Accepted=true

[BitTorrent]
Session\\DefaultSavePath=/downloads
Session\\Port=6882

[Preferences]
WebUI\\Port=8090
WebUI\\Username=admin
WebUI\\Password_PBKDF2="@ByteArray({base64.b64encode(salt).decode()}:{base64.b64encode(key).decode()})"
WebUI\\HostHeaderValidation=false
""")
PY

run deluge lscr.io/linuxserver/deluge:latest
run qbittorrent lscr.io/linuxserver/qbittorrent:latest -e WEBUI_PORT=8090 -e TORRENTING_PORT=6882
run transmission lscr.io/linuxserver/transmission:latest -e USER=transuser -e PASS=transpass
run sabnzbd lscr.io/linuxserver/sabnzbd:latest
run nzbget lscr.io/linuxserver/nzbget:latest -e NZBGET_USER=nzbuser -e NZBGET_PASS=nzbpass

# rTorrent, from Ubuntu, with nginx giving its XML-RPC basic auth.
sudo apt-get install -y -qq rtorrent nginx-light apache2-utils >/dev/null
cat >"$ROOT/rtorrent/rtorrent.rc" <<RC
directory.default.set = $ROOT/rtorrent/downloads
session.path.set = $ROOT/rtorrent/session
network.scgi.open_port = 127.0.0.1:5000
network.port_range.set = 50000-50000
dht.mode.set = disable
protocol.pex.set = no
system.daemon.set = true
RC
(cd "$ROOT/rtorrent" && HOME="$ROOT/rtorrent" nohup rtorrent -n -o "import=$ROOT/rtorrent/rtorrent.rc" >"$ROOT/rtorrent/rtorrent.log" 2>&1 &)
htpasswd -bc "$ROOT/rtorrent/nginx/htpasswd" rtuser rtpass >/dev/null 2>&1
cat >"$ROOT/rtorrent/nginx/nginx.conf" <<NGINX
pid $ROOT/rtorrent/nginx/nginx.pid;
error_log $ROOT/rtorrent/nginx/error.log;
events {}
http {
  access_log off;
  client_body_temp_path $ROOT/rtorrent/nginx/tmp;
  server {
    listen 127.0.0.1:8081;
    location /RPC2 {
      auth_basic "rtorrent";
      auth_basic_user_file $ROOT/rtorrent/nginx/htpasswd;
      include /etc/nginx/scgi_params;
      scgi_pass 127.0.0.1:5000;
    }
  }
}
NGINX
nginx -c "$ROOT/rtorrent/nginx/nginx.conf"

# Each one answering before the checks start.
wait_for() {
  local what=$1 url=$2 code
  for _ in $(seq 1 90); do
    # Any answer at all, a sign-in prompt included.
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)
    if [ "$code" != 000 ]; then return 0; fi
    sleep 2
  done
  echo "$what did not start" >&2
  return 1
}
wait_for Deluge http://127.0.0.1:8112/
wait_for qBittorrent http://127.0.0.1:8090/
wait_for Transmission http://127.0.0.1:9091/transmission/web/
wait_for SABnzbd http://127.0.0.1:8080/
wait_for NZBGet http://127.0.0.1:6789/
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null -u rtuser:rtpass -H 'Content-Type: text/xml' \
    -d '<?xml version="1.0"?><methodCall><methodName>system.client_version</methodName><params/></methodCall>' \
    http://127.0.0.1:8081/RPC2; then break; fi
  sleep 1
done

# SABnzbd makes its API key on its first start.
for _ in $(seq 1 30); do
  key=$(sed -n 's/^api_key = \(.*\)$/\1/p' "$ROOT/sabnzbd/config/sabnzbd.ini" 2>/dev/null || true)
  [ -n "$key" ] && break
  sleep 1
done
[ -n "$key" ] || { echo "SABnzbd made no API key" >&2; exit 1; }
if [ -n "${GITHUB_ENV:-}" ]; then echo "::add-mask::$key"; fi
echo "REAL_SABNZBD_KEY=$key" >>"$OUT"
echo "REAL_CLIENTS=all" >>"$OUT"
