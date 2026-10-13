import path from "node:path"
import { startFakes } from "./fakes.mjs"
const work = process.argv[2]
const f = await startFakes({ upPort: 18443, socksPort: 19250, controlPort: 19251, stateDir: path.join(work, "home", ".local", "state", "opencode-tor-rotate"), certDir: work })
setInterval(() => {}, 1000)
console.log("fakes up")
