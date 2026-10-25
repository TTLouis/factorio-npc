// Offline helper fixture only. Never use its fake native compile for an engine run.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {freezePair} from './pair.mjs'
const [repo,evidence]=process.argv.slice(2)
const fixture=path.join(evidence,'fixture-inputs')
fs.mkdirSync(fixture,{recursive:true})
const nativeDir=path.join(fixture,'native');fs.mkdirSync(nativeDir,{recursive:true})
const content='{"name":"offline-helper-fixture-only"}\n'
fs.writeFileSync(path.join(nativeDir,'info.json'),content)
const nativeManifest=path.join(fixture,'manifest.json')
fs.writeFileSync(nativeManifest,JSON.stringify([{path:'info.json',sha256:crypto.createHash('sha256').update(content).digest('hex')}]))
const candidate=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
const output=path.join(evidence,'rendered-pair')
freezePair({repo,output,nativeDir,nativeManifest,nativeBuildSource:candidate,candidate,published:'b'.repeat(40),imageId:'sha256:'+'c'.repeat(64)})
console.log('Rendered offline helper fixture; no native/gameplay claim: '+output)
