# opencode-tor-rotate (v3)

OpenCode V2 plugin. When the free OpenCode Zen quota is hit, it asks Tor for a new exit IP, checks that the
new IP really works (a tiny real request to your model, made by the plugin itself), then tells the agent
to continue. Only `opencode.ai` traffic ever goes through Tor, and **only when you turn it on**.

## How it behaves

- **Off by default.** The plugin loads with `opencode2` but traffic stays direct until you run `tor on`.
- **Commands** (slash commands / command palette `ctrl+p`): `tor-on`, `tor-off`, `tor-rotate`, `tor-status`.
- **Hard limit** (end of quota / "Free usage exceeded, subscribe to Go"): recovery starts immediately.
- **Soft limit** (plain "Rate limit exceeded"): the plugin sends `Continue where you left off`; if the same
  session gets the soft error 3 times in a row it is treated as a limit. A success in between resets the count.
- **Recovery**: note current IP -> new Tor circuit -> make sure the IP differs -> test request to the model
  through Tor -> repeat. Max **10 attempts / 5 minutes**. On success every session that was stopped by the limit
  (sub-agents included) receives `Continue where you left off`. On failure a popup/toast explains why.
  The test request **replays the real client's fingerprint** (headers captured from the `model.request`
  hook: session affinity, UA, project...): the gateway answers `403 FreeTierError` to forged fingerprints,
  so replay is what makes validation pass. Before any real request exists, a forged fingerprint is used
  (correct id shapes, may still 403 — informational only).
- **Endpoint per model**: chat models validate against `<base>/chat/completions`, `muse-spark-*-free`
  against `<base>/responses` (OpenAI Responses API) — the base URL is the one the real client used.
- **UI**: a popup while recovery runs, a sidebar panel (mode, exit IP + "is a Tor exit" check, rotations,
  requests ok/failed, attempts, quota reset time in your local time, number of Tor exits from Onionoo, direct-IP
  quota state) and a status line.
- **Startup check**: one tiny direct request (no Tor) tells you whether your own IP is already out of quota.
- Other errors (`service_overloaded`, 403 fingerprint block...) are never touched.

## Install

1. Install Node-free: nothing to build. Copy this folder anywhere, e.g. `~/.config/opencode/plugins/tor-rotate`
   (Windows: `C:\Users\<you>\.config\opencode\plugins\tor-rotate`).
2. Declare it in your **global** config `~/.config/opencode/opencode.jsonc` (a project config only works from
   that project and its sub-folders):
   ```jsonc
   { "plugins": [ { "package": "/absolute/path/to/tor-rotate" } ] }
   ```
   `plugins` must be an **array**. The folder must contain `index.js` at its root (OpenCode 2.0.6 ignores it otherwise).
3. Restart the background service: `opencode2 service restart`, then start `opencode2`.
4. Tor: the plugin looks for `tor` in PATH / usual locations and tries to install it when missing
   (scoop/choco/winget, apt/dnf/pacman, brew, Termux `pkg`). If that fails you get a clear error; install it
   yourself (`scoop install tor`, `sudo apt install tor`, `brew install tor`, `pkg install tor`) or set `torPath`.
5. In OpenCode run `tor-on`. Use `tor-status` to check.

Windows note: if `opencode2` fails to start with "Background service failed to start", check `auth.json`
for a UTF-8 BOM (remove it) - unrelated to this plugin.

## Options (`"options": {...}` next to `package`)

| option | default | meaning |
| --- | --- | --- |
| `relayPort` / `socksPort` / `controlPort` | 9253 / 9250 / 9251 | local ports |
| `torPath` | auto | path to the tor binary |
| `autoInstallTor` | true | try to install tor if missing |
| `maxAttempts` / `timeoutMs` | 10 / 300000 | recovery limits |
| `softThreshold` | 3 | soft errors in a row before it counts as a limit |
| `resumeText` | `Continue where you left off` | message sent to the stopped sessions |
| `resumeChildren` | true | resume all stopped sessions (false: only the one that triggered) |
| `hardPattern` | see `src/classify.js` | regex deciding what is a hard limit |
| `startupProbe` | true | direct quota check at startup |
| `defaultModel` | `big-pickle` | model used for the startup/validation request when none is known |
| `providerID` / `upstream` | `opencode` / `https://opencode.ai` | which provider/host is routed |

## How it works

`model.request` hook rewrites the Zen base URL to a loopback relay when Tor is on; the relay forwards to
`opencode.ai` directly or through Tor's SOCKS port. `retry` hook sees the failure, classifies it and stops
OpenCode's own retry while the plugin recovers. `ctx.session.prompt` sends the resume message. The TUI part is
a client of the relay's `/__tor/*` API. State lives in the service process, logs in
`~/.local/state/opencode-tor-rotate/plugin.log` (Windows: `%LOCALAPPDATA%\opencode-tor-rotate`).

## Tests

`npm test` (node, no dependencies), `npm run build && npm run test:tui` (needs `npm i` and bun),
`test/e2e/run.sh <opencode2> <workdir>` (real opencode2 + fake Zen/Tor).

## Known limits / not verified

- Not run against the real Tor network or the real Zen service in development.
- The exact body of Zen's "rate limit" vs "end of quota" errors is unknown: classification uses message/type
  patterns; tune `hardPattern` if a limit is misclassified.
- Sub-agent resume is implemented but untested on a real run.
- On OpenCode builds older or newer than 2.0.6 hook shapes may differ (docs: opencode-v2-docs-local.zip).