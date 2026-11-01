import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root=path.dirname(fileURLToPath(import.meta.url))
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))
const pair=read(path.join(root,'pair.json'))
const counts=[]
for(const lane of pair.lanes) {
  const logs=path.join(root,lane.id,'data/logs')
  const countsFor=base=>{
    const lines=new Set()
    const names=fs.readdirSync(logs).filter(n=>n===base||new RegExp(`^${base.replaceAll('.','\\.')}\\.\\d+$`).test(n))
    if(!names.length)return {available:false,events:{},retainedUniqueRows:null}
    for(const name of names)for(const line of fs.readFileSync(path.join(logs,name),'utf8').split('\n'))if(line)lines.add(line)
    const rows=[...lines].flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
    return {available:true,events:Object.fromEntries([...new Set(rows.map(r=>r.event))].map(event=>[event,rows.filter(r=>r.event===event).length])),retainedUniqueRows:rows.length}
  }
  const provider=countsFor('sgluna-prompts.jsonl'); const jev=countsFor('sgluna-decision.jsonl')
  let result='unavailable';try{result=read(path.join(logs,'e2e-result.json')).result}catch{}
  counts.push({runId:lane.runId,seed:lane.seed,result,providerRequests:provider.available?(provider.events['provider.request']??0):null,jevRequests:jev.available?(jev.events['decision.request']??0):null,provider,jev,
    estimatedCost:{amount:null,currency:'USD',status:'unpriced',reason:'Complete lane report must supply observed usage, model/role rates with source/date and subscription token-equivalent assumptions.'}})
}
const artifact={pairId:pair.pairId,candidate:pair.candidate,profile:pair.profile,lanes:counts,
  combined:{providerRequests:counts.every(l=>l.providerRequests!==null)?counts.reduce((s,l)=>s+l.providerRequests,0):null,jevRequests:counts.every(l=>l.jevRequests!==null)?counts.reduce((s,l)=>s+l.jevRequests,0):null,estimatedCost:{amount:null,currency:'USD',status:'unpriced'}},
  quota:{...pair.sharedQuota,accountScope:'shared across both lanes; lane request/recovery guards are separate and do not constitute a global quota'},
  completeness:'Request-event index only. Not a replacement for required per-lane recovery/tool/time/actual-plan/token/cost reports. Missing logs must be investigated; costs and thinking duration unavailable.',
  countingRule:'Exact retained JSONL lines deduplicated within lane across numeric rotations; runId qualifies each lane namespace. Combined values add lane request events, never Codex usage percentages or money.'}
fs.writeFileSync(path.join(root,'combined-call-index.json'),`${JSON.stringify(artifact,null,2)}\n`)
console.log(JSON.stringify(artifact.combined))
