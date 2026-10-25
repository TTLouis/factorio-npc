import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root=path.dirname(fileURLToPath(import.meta.url))
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))
export async function verifyPeerSuccess(root,id) {
  const pair=read(path.join(root,'pair.json')),lane=pair.lanes.find(l=>l.id===id)
  if(!lane)throw Error('Unknown peer lane')
  const local=path.join(root,id),logs=path.join(local,'data/logs')
  const {evaluateMeasurement}=await import(pathToFileURL(path.join(local,'automation-proof.mjs')))
  const result=read(path.join(logs,'e2e-result.json'))
  const completion=read(path.join(logs,'e2e-completion-proof.json'))
  const samples=read(path.join(logs,'e2e-measurement-samples.json'))
  const evaluated=evaluateMeasurement(samples)
  if(result.run_id!==lane.runId||result.result!=='native_automated_red_rate_success'||completion.satisfied!==true||!evaluated.satisfied||result.before?.seed!==lane.seed||
      result.stop_confirmation?.receipt_scope?.run_id!==lane.runId||result.stop_confirmation?.boundary!=='fresh_supervisor_cancel_and_same_goal_operator_pause'||
      completion.goal_id!==result.goal_id||completion.initial_actor!==result.before?.actor_id)throw Error('Verified native peer acceptance absent')
  const sourceFiles=['e2e-result.json','e2e-completion-proof.json','e2e-measurement-samples.json']
  return {runId:lane.runId,candidate:pair.candidate,seed:lane.seed,verified:true,goalId:result.goal_id,evaluated,
    sources:sourceFiles.map(name=>({path:'data/logs/'+name,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(logs,name))).digest('hex')}))}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const proof=await verifyPeerSuccess(root,process.argv[2])
  fs.writeFileSync(path.join(root,process.argv[2],'peer-acceptance.json'),JSON.stringify(proof,null,2)+'\n')
  console.log(JSON.stringify({runId:proof.runId,verified:true}))
}
