// src/tui.tsx
import { insert as _$insert } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal, For, Show } from "solid-js";

// src/client.js
import http from "node:http";
function call(port, method, name, body, timeoutMs = 1e4) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: `/__tor/${name}`, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(data || "{}");
          res.statusCode >= 400 ? reject(new Error(j.error ?? `HTTP ${res.statusCode}`)) : resolve(j);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload)
      req.write(payload);
    req.end();
  });
}
var getStatus = (port) => call(port, "GET", "status");
var command = (port, name, body, timeoutMs) => call(port, "POST", name, body, timeoutMs);

// src/tui-model.js
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}:${String(sec).padStart(2, "0")}`;
}
function localReset(resetAtIso, now = Date.now(), locale, timeZone) {
  const t = new Date(resetAtIso);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short" }).format(t);
  return { time, inMs: t.getTime() - now };
}
function summarize(st, now = Date.now(), locale, timeZone) {
  if (!st)
    return { offline: true, lines: [], headline: "Tor: plugin not loaded" };
  const on = st.enabled;
  const torState = st.tor?.state ?? "stopped";
  const headline = st.outage?.active ? `Tor: finding a clean IP (${st.outage.attempt ?? 0}/${st.outage.maxAttempts})` : on ? `Tor: ON${st.ip ? ` · ${st.ip}` : ""}` : "Tor: OFF";
  const reset = st.resetAt ? localReset(st.resetAt, now, locale, timeZone) : undefined;
  const lines = [
    ["Mode", on ? "ON (via Tor)" : "OFF (direct)"],
    ["Tor daemon", torState + (st.tor?.error ? ` - ${st.tor.error}` : "")],
    ["Exit IP", st.ip ? `${st.ip}${st.ipIsTor === undefined ? "" : st.ipIsTor ? " (Tor exit)" : " (NOT a Tor exit!)"}` : "-"],
    ["Rotations", String(st.stats?.rotations ?? 0)],
    ["Requests", `${st.stats?.ok ?? 0} ok / ${st.stats?.failed ?? 0} failed`],
    ["Outages", String(st.stats?.outages ?? 0)]
  ];
  if (st.outage?.active) {
    const elapsed = now - st.outage.startedAt;
    lines.push(["Recovery", `attempt ${st.outage.attempt ?? 0}/${st.outage.maxAttempts} · ${st.outage.phase ?? "..."} · ${fmtDuration(elapsed)}/${fmtDuration(st.cfg?.timeoutMs ?? 300000)}`]);
  } else if (st.lastOutage) {
    lines.push(["Last outage", st.lastOutage.ok ? `ok (${st.lastOutage.ip}, ${st.lastOutage.attempts} tries)` : `FAILED: ${st.lastOutage.reason}`]);
  }
  if (reset)
    lines.push(["Quota reset", `${reset.time} (in ${fmtDuration(reset.inMs)})`]);
  if (st.exits !== undefined)
    lines.push(["Tor exits", st.exits.toLocaleString("en-US")]);
  if (st.probe)
    lines.push(["Direct IP", st.probe.ok ? "has quota" : st.probe.kind ? `LIMITED (${st.probe.kind})` : `check failed (${st.probe.detail})`]);
  return { offline: false, headline, lines, outage: st.outage, notice: st.notice };
}

// src/tui.tsx
var tui_default = {
  id: "tor-rotate.tui",
  setup(context) {
    const port = Number(context.options?.relayPort ?? 9253);
    const [status, setStatus] = createSignal(undefined);
    const [now, setNow] = createSignal(Date.now());
    let lastNotice = 0;
    let dialogOpen = false;
    let dismissed = false;
    let probeToast = false;
    const toast = (message, variant = "info", title = "Tor") => context.ui.toast.show({
      title,
      message,
      variant
    });
    const view = () => summarize(status(), now());
    const Popup = () => {
      const v = () => view();
      return (() => {
        var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$4 = _$createElement("text");
        _$insertNode(_el$, _el$2);
        _$insertNode(_el$, _el$4);
        _$setProp(_el$, "flexDirection", "column");
        _$setProp(_el$, "padding", 1);
        _$setProp(_el$, "gap", 1);
        _$setProp(_el$, "minWidth", 52);
        _$insertNode(_el$2, _$createTextNode(`⏳ Quota limit reached - finding a clean IP`));
        _$insertNode(_el$4, _$createTextNode(`Please wait, do not send messages. Your session will continue automatically.`));
        _$insert(_el$, _$createComponent(For, {
          get each() {
            return v().lines.filter((l) => ["Recovery", "Exit IP", "Rotations"].includes(l[0]));
          },
          children: (l) => (() => {
            var _el$6 = _$createElement("text");
            _$insert(_el$6, () => `${l[0]}: ${l[1]}`);
            return _el$6;
          })()
        }), null);
        return _el$;
      })();
    };
    const poll = async () => {
      setNow(Date.now());
      try {
        const st = await getStatus(port);
        setStatus(st);
        if (st.notice && st.notice.id !== lastNotice) {
          if (lastNotice !== 0 || st.notice.at > Date.now() - 15000)
            toast(st.notice.text, st.notice.level === "warning" ? "warning" : st.notice.level);
          lastNotice = st.notice.id;
        }
        if (st.probe && !probeToast && st.probe.kind && !st.enabled)
          probeToast = true;
        if (st.outage?.active && !dialogOpen && !dismissed) {
          dialogOpen = true;
          context.ui.dialog.set?.({
            size: "medium",
            centered: true
          });
          context.ui.dialog.show(() => _$createComponent(Popup, {}), () => {
            if (dialogOpen)
              dismissed = true;
            dialogOpen = false;
          });
        } else if (!st.outage?.active) {
          dismissed = false;
          if (dialogOpen) {
            dialogOpen = false;
            context.ui.dialog.clear();
          }
        }
      } catch {
        setStatus(undefined);
      }
    };
    const timer = setInterval(poll, 1000);
    poll();
    const run = async (name, label) => {
      try {
        await command(port, name, undefined, name === "rotate" ? 330000 : 130000);
      } catch (e) {
        toast(`${label}: ${e.message}`, "error");
      }
    };
    const appSlot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "tor.on",
            title: "Tor: enable routing through Tor",
            group: "Tor",
            palette: true,
            slash: {
              name: "tor-on"
            },
            run: () => void run("enable", "tor on")
          }, {
            id: "tor.off",
            title: "Tor: disable routing (direct)",
            group: "Tor",
            palette: true,
            slash: {
              name: "tor-off"
            },
            run: () => void run("disable", "tor off")
          }, {
            id: "tor.rotate",
            title: "Tor: rotate to a new validated IP",
            group: "Tor",
            palette: true,
            slash: {
              name: "tor-rotate"
            },
            run: () => void run("rotate", "tor rotate")
          }, {
            id: "tor.status",
            title: "Tor: show status",
            group: "Tor",
            palette: true,
            slash: {
              name: "tor-status"
            },
            run: () => void context.ui.dialog.alert({
              title: "Tor",
              message: view().lines.map((l) => `${l[0]}: ${l[1]}`).join(`
`) || "plugin not loaded"
            })
          }]
        }));
        return null;
      }
    });
    const Line = (p) => (() => {
      var _el$7 = _$createElement("text");
      _$insert(_el$7, () => `${p.k}: ${p.v}`);
      return _el$7;
    })();
    const unslot = [appSlot, context.ui.slot({
      append: "prompt.footer.status",
      render: () => (() => {
        var _el$8 = _$createElement("text");
        _$insert(_el$8, () => view().headline);
        return _el$8;
      })()
    }), context.ui.slot({
      append: "home.footer.status",
      render: () => (() => {
        var _el$9 = _$createElement("text");
        _$insert(_el$9, () => view().headline);
        return _el$9;
      })()
    }), context.ui.slot({
      append: "sidebar.content",
      render: () => (() => {
        var _el$0 = _$createElement("box"), _el$1 = _$createElement("text");
        _$insertNode(_el$0, _el$1);
        _$setProp(_el$0, "flexDirection", "column");
        _$setProp(_el$0, "paddingTop", 1);
        _$insert(_el$0, () => `── ${view().headline} ──`);
        _$insert(_el$0, _$createComponent(Show, {
          get when() {
            return !view().offline;
          },
          get fallback() {
            return (() => {
              var _el$10 = _$createElement("text");
              _$insertNode(_el$10, _el$10 = _el$10, _el$10);
              return _el$10;
            })();
          },
          get children() {
            return _$createComponent(For, {
              get each() {
                return view().lines;
              },
              children: (l) => _$createComponent(Line, {
                get k() {
                  return l[0];
                },
                get v() {
                  return l[1];
                }
              })
            });
          }
        }), null);
        return _el$0;
      })()
    })];
    return () => {
      clearInterval(timer);
      for (const u of unslot)
        typeof u === "function" && u();
    };
  }
};
export {
  tui_default as default
};
