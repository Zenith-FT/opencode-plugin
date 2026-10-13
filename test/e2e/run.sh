#!/usr/bin/env bash
# End-to-end against a REAL opencode2 binary, with a fake Zen upstream and fake Tor (no network needed).
# Usage: test/e2e/run.sh /path/to/opencode2 /path/to/workdir
# Expected: the first chat gets a hard 429, the plugin rotates twice (first candidate IP still limited,
# second one accepted), then sends "Continue where you left off" and the session ends "succeeded".
set -u
BIN=$1; W=$2; ROOT=$(cd "$(dirname "$0")/../.." && pwd)
rm -rf "$W"; mkdir -p "$W/proj" "$W/plugin"; H=$W/home
cp -r "$ROOT/index.js" "$ROOT/tui.js" "$ROOT/src" "$ROOT/dist" "$ROOT/package.json" "$W/plugin/"
UP=18443; SOCKS=19250; CTL=19251; RELAY=19253
cat > "$W/proj/opencode.jsonc" <<JSON
{ "providers": { "fakezen": { "name": "Fake", "env": ["FAKE_KEY"], "package": "@opencode/ai/providers/openai-compatible",
    "settings": { "baseURL": "https://localhost:$UP/zen/v1" }, "models": { "m": { "name": "M" } } } },
  "plugins": [ { "package": "$W/plugin", "options": { "providerID": "fakezen", "upstream": "https://localhost:$UP",
    "relayPort": $RELAY, "socksPort": $SOCKS, "controlPort": $CTL, "startupProbe": false, "ipPollMs": 50, "defaultModel": "m" } } ] }
JSON
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_DATA_HOME=$H/.local/share XDG_STATE_HOME=$H/.local/state XDG_CACHE_HOME=$H/.cache
export NODE_EXTRA_CA_CERTS=$W/ca.pem FAKE_KEY=k
node "$ROOT/test/e2e/fakes-server.mjs" "$W" > "$W/fakes.log" 2>&1 & FAKES=$!
trap 'kill $FAKES 2>/dev/null; "$BIN" service stop >/dev/null 2>&1' EXIT
sleep 2
cd "$W/proj"
"$BIN" service stop >/dev/null 2>&1; "$BIN" service start >/dev/null 2>&1
for i in 1 2; do "$BIN" api get /api/plugin -H "x-opencode-directory: $W/proj" >/dev/null 2>&1 </dev/null; sleep 2; done
curl -s -m5 -XPOST http://127.0.0.1:$RELAY/__tor/enable >/dev/null
OUT=$(timeout 40 "$BIN" run --model fakezen/m --format json "say hi" 2>&1 </dev/null)
echo "run: $OUT" | cut -c1-200
sleep 6
echo "--- plugin.log"; tail -4 "$H/.local/state/opencode-tor-rotate/plugin.log"
echo "--- fake tor"; grep -v CONNECT "$W/fakes.log" | grep NEWNYM
SID=$(echo "$OUT" | python3 -c "import sys,json;print(json.loads(sys.stdin.readline())['sessionID'])")
echo "--- session"; "$BIN" api get /api/session/$SID/message </dev/null | python3 -c "
import sys,json
for m in reversed(json.load(sys.stdin)['data']): print(' ', m.get('type'), m.get('text') or m.get('outcome') or m.get('finish') or '')"
