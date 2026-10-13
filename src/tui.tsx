/** @jsxImportSource @opentui/solid */
// opencode-tor-rotate — TUI part: status line, sidebar, recovery popup, commands, toasts.
// It is a pure client of the relay's /__tor/* API (the service part owns all state).
import { createSignal, For, Show } from "solid-js"

import { command, getStatus } from "./client.js"
import { summarize } from "./tui-model.js"

type Ctx = any

export default {
  id: "tor-rotate.tui",
  setup(context: Ctx) {
    const port = Number(context.options?.relayPort ?? 9253)
    const [status, setStatus] = createSignal<any>(undefined)
    const [now, setNow] = createSignal(Date.now())
    let lastNotice = 0
    let dialogOpen = false
    let dismissed = false
    let probeToast = false

    const toast = (message: string, variant = "info", title = "Tor") => context.ui.toast.show({ title, message, variant })

    const view = () => summarize(status(), now())

    const Popup = () => {
      const v = () => view()
      return (
        <box flexDirection="column" padding={1} gap={1} minWidth={52}>
          <text>⏳ Quota limit reached - finding a clean IP</text>
          <text>Please wait, do not send messages. Your session will continue automatically.</text>
          <For each={v().lines.filter((l) => ["Recovery", "Exit IP", "Rotations"].includes(l[0]))}>
            {(l) => <text>{`${l[0]}: ${l[1]}`}</text>}
          </For>
        </box>
      )
    }

    const poll = async () => {
      setNow(Date.now())
      try {
        const st = await getStatus(port)
        setStatus(st)
        if (st.notice && st.notice.id !== lastNotice) {
          if (lastNotice !== 0 || st.notice.at > Date.now() - 15_000) toast(st.notice.text, st.notice.level === "warning" ? "warning" : st.notice.level)
          lastNotice = st.notice.id
        }
        if (st.probe && !probeToast && st.probe.kind && !st.enabled) probeToast = true
        if (st.outage?.active && !dialogOpen && !dismissed) {
          dialogOpen = true
          context.ui.dialog.set?.({ size: "medium", centered: true })
          context.ui.dialog.show(
            () => <Popup />,
            () => {
              // Escape pressed: the recovery goes on, we just do not re-open the popup for this outage.
              if (dialogOpen) dismissed = true
              dialogOpen = false
            },
          )
        } else if (!st.outage?.active) {
          dismissed = false
          if (dialogOpen) {
            dialogOpen = false
            context.ui.dialog.clear()
          }
        }
      } catch {
        setStatus(undefined)
      }
    }
    const timer = setInterval(poll, 1000)
    poll()

    const run = async (name: string, label: string) => {
      try {
        await command(port, name, undefined, name === "rotate" ? 330_000 : 130_000)
      } catch (e: any) {
        toast(`${label}: ${e.message}`, "error")
      }
    }

    const appSlot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            { id: "tor.on", title: "Tor: enable routing through Tor", group: "Tor", palette: true, slash: { name: "tor-on" }, run: () => void run("enable", "tor on") },
            { id: "tor.off", title: "Tor: disable routing (direct)", group: "Tor", palette: true, slash: { name: "tor-off" }, run: () => void run("disable", "tor off") },
            { id: "tor.rotate", title: "Tor: rotate to a new validated IP", group: "Tor", palette: true, slash: { name: "tor-rotate" }, run: () => void run("rotate", "tor rotate") },
            {
              id: "tor.status",
              title: "Tor: show status",
              group: "Tor",
              palette: true,
              slash: { name: "tor-status" },
              run: () => void context.ui.dialog.alert({ title: "Tor", message: view().lines.map((l) => `${l[0]}: ${l[1]}`).join("\n") || "plugin not loaded" }),
            },
          ],
        }))
        return null
      },
    })

    const Line = (p: { k: string; v: string }) => <text>{`${p.k}: ${p.v}`}</text>

    const unslot = [
      appSlot,
      context.ui.slot({
        append: "prompt.footer.status",
        render: () => <text>{view().headline}</text>,
      }),
      context.ui.slot({
        append: "home.footer.status",
        render: () => <text>{view().headline}</text>,
      }),
      context.ui.slot({
        append: "sidebar.content",
        render: () => (
          <box flexDirection="column" paddingTop={1}>
            <text>{`── ${view().headline} ──`}</text>
            <Show when={!view().offline} fallback={<text>Plugin not loaded (restart opencode2)</text>}>
              <For each={view().lines}>{(l) => <Line k={l[0]} v={l[1]} />}</For>
            </Show>
          </box>
        ),
      }),
    ]

    return () => {
      clearInterval(timer)
      for (const u of unslot) typeof u === "function" && u()
    }
  },
}
