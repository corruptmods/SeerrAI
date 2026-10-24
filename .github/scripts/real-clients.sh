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

# What went wrong, in the run's summary as well as its log.
fail() {
  echo "::error title=$1::$(printf '%s' "$2" | sed ':a;N;$!ba;s/%/%25/g;s/\n/%0A/g')"
  exit 1
}

run() {
  local name=$1 image=$2 out
  shift 2
  # A registry that hiccups is tried again.
  for _ in 1 2 3; do
    out=$(docker pull -q "$image" 2>&1) && break
    sleep 15
  done || true
  out=$(docker run -d --name "real-$name" --network host \
    -e PUID="$U" -e PGID="$G" -e TZ=Etc/UTC \
    -v "$ROOT/$name/config:/config" -v "$ROOT/$name/downloads:/downloads" \
    "$@" "$image" 2>&1) || fail "$name" "$out"
  # SABnzbd, for one, finishes into /config/Downloads unless told otherwise.
  echo "REAL_${name^^}_PATHS=/downloads=$ROOT/$name/downloads,/config=$ROOT/$name/config" >>"$OUT"
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
  fail "$what" "$what did not start"
}
wait_for Deluge http://127.0.0.1:8112/
wait_for qBittorrent http://127.0.0.1:8090/
wait_for Transmission http://127.0.0.1:9091/transmission/web/
wait_for SABnzbd http://127.0.0.1:8080/
wait_for NZBGet http://127.0.0.1:6789/

# qBittorrent 5 may ignore the password above and make up one for the
# session, which it logs: then it's signed in with that and given ours.
qbit_login() {
  curl -s -o /dev/null -w '%{http_code}' -c "$ROOT/qbittorrent/jar" \
    --data-urlencode username=admin --data-urlencode "password=$1" \
    http://127.0.0.1:8090/api/v2/auth/login
}
qbit_ok() {
  [ "$(curl -s -b "$ROOT/qbittorrent/jar" http://127.0.0.1:8090/api/v2/app/version -o /dev/null -w '%{http_code}')" = 200 ]
}
for _ in $(seq 1 30); do
  qbit_login adminadmin >/dev/null
  if qbit_ok; then break; fi
  temp=$(docker logs real-qbittorrent 2>&1 | sed -n 's/.*temporary password is provided for this session: *\(.*\)$/\1/p' | tail -n 1 | tr -d '\r')
  if [ -n "$temp" ]; then
    if [ -n "${GITHUB_ENV:-}" ]; then echo "::add-mask::$temp"; fi
    qbit_login "$temp" >/dev/null
    if qbit_ok; then
      curl -s -b "$ROOT/qbittorrent/jar" \
        --data-urlencode 'json={"web_ui_password":"adminadmin"}' \
        http://127.0.0.1:8090/api/v2/app/setPreferences
      echo "qBittorrent made up its own password; it now has the one the checks use"
      break
    fi
  fi
  sleep 2
done
qbit_login adminadmin >/dev/null
qbit_ok || fail qBittorrent "It would not take the checks' password.
$(docker logs real-qbittorrent 2>&1 | tail -n 15)"
rm -f "$ROOT/qbittorrent/jar"
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
[ -n "$key" ] || fail SABnzbd "It made no API key"
if [ -n "${GITHUB_ENV:-}" ]; then echo "::add-mask::$key"; fi
echo "REAL_SABNZBD_KEY=$key" >>"$OUT"
echo "REAL_CLIENTS=all" >>"$OUT"
