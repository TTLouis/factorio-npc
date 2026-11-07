import fs from 'node:fs'
const target = process.argv[2]
const marker = 'return require("control", ...)'
const source = fs.readFileSync(target, 'utf8')
if (source.split(marker).length !== 2) throw new Error('Expected one TypeScriptToLua control entry point')
const hook = fs.readFileSync(new URL('./fluid-connection-proof.lua', import.meta.url), 'utf8')
fs.writeFileSync(target, source.replace(marker, hook + '\n' + marker))