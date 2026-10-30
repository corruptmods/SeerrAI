#!/usr/bin/env bash
# Security advisories, checked before every build (build.sh runs this):
#  - every package that goes in the image, against npm's advisories (pnpm
#    audit of the lockfile). An advisory with no fixed release, for a
#    package patched in patches/ or one the server never loads, is listed in
#    package.json under pnpm.auditConfig.ignoreGhsas, and still shown here;
#  - a Node.js 22 release with security fixes newer than the image's.
# It runs in the image's own Node.js, so the host needs only Docker. It
# stops the build when it finds anything, or can't check.
set -euo pipefail
cd "$(dirname "$0")"

BASE=$(awk '/^FROM node:/ { print $2; exit }' Dockerfile)
IMAGE_NODE=$(sed -E 's/^node:([0-9]+\.[0-9]+\.[0-9]+).*/\1/' <<<"$BASE")

# shellcheck disable=SC2016
CHECK='
set -u
failed=0

echo "Packages in the image:"
if ! pnpm audit --prod; then
  failed=1
fi
node -e "
const ignored = require(\"./package.json\").pnpm?.auditConfig?.ignoreGhsas ?? [];
if (ignored.length) console.log(\"Not counted, as package.json says (no fixed release yet: patched in patches/, or never loaded by the server): \" + ignored.join(\", \"));
"

echo
echo "Development tools (not in the image, for information):"
pnpm audit --dev --audit-level low >/dev/null 2>&1 &&
  echo "No known advisories." ||
  pnpm audit --dev 2>/dev/null | tail -n 2

echo
echo "Node.js:"
node -e "
const have = process.env.IMAGE_NODE.split(\".\").map(Number);
const newer = (v) => {
  const n = v.slice(1).split(\".\").map(Number);
  for (let i = 0; i < 3; i++) if (n[i] !== have[i]) return n[i] > have[i];
  return false;
};
fetch(\"https://nodejs.org/dist/index.json\")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(\"HTTP \" + r.status))))
  .then((releases) => {
    const later = releases.filter((r) => r.version.startsWith(\"v22.\") && newer(r.version));
    const fixes = later.filter((r) => r.security);
    if (fixes.length) {
      console.log(\"Node.js \" + fixes[0].version + \" has security fixes; the image has v\" + process.env.IMAGE_NODE + \". Move both FROM lines in the Dockerfile to \" + later[0].version + \", the newest 22.\");
      process.exit(1);
    }
    console.log(later.length
      ? \"Node.js \" + later[0].version + \" is out, with no security fixes; the image has v\" + process.env.IMAGE_NODE + \".\"
      : \"v\" + process.env.IMAGE_NODE + \" is the newest Node.js 22.\");
  })
  .catch((e) => {
    console.log(\"Could not check Node.js releases: \" + e.message);
    process.exit(1);
  });
" || failed=1

exit $failed
'

if [ "${SECURITY_CHECK_HERE:-}" = 1 ]; then
  # Without Docker, with this machine's own Node.js and pnpm.
  IMAGE_NODE="$IMAGE_NODE" bash -c "$CHECK"
else
  docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e IMAGE_NODE="$IMAGE_NODE" \
    -v "$PWD/package.json:/check/package.json:ro" \
    -v "$PWD/pnpm-lock.yaml:/check/pnpm-lock.yaml:ro" \
    -w /check \
    --entrypoint sh \
    "$BASE" -c "corepack enable && $CHECK"
fi
