// RCON control transport substitute only; no provider/native world is started.
import fs from 'node:fs/promises'
import path from 'node:path'
import {supervisorStop} from './templates/trial-supervisor-stop.mjs'
const [laneRoot,runId]=process.argv.slice(2)
const decision=await supervisorStop({root:path.join(laneRoot,'data'),expectedRunId:runId,rcon:{command:async command=>{
  await fs.appendFile(path.join(laneRoot,'control-rcon.jsonl'),`${JSON.stringify({command,at:Date.now()})}\n`)
}}})
console.log(JSON.stringify(decision))
