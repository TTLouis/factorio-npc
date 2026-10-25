import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {operatorStopReason} from './pair-stop-policy.mjs'

export async function withLaunchGate(root, action, {timeoutMs=20000}={}) {
  const file=path.join(root,'launch-control.lock'),token=crypto.randomUUID(),deadline=Date.now()+timeoutMs
  let handle
  while(!handle) {
    try {handle=await fs.open(file,'wx');await handle.writeFile(token);await handle.sync()}
    catch(error){if(error.code!=='EEXIST'||Date.now()>=deadline)throw error;await new Promise(r=>setTimeout(r,10))}
  }
  try {return await action()}
  finally {await handle.close();if(await fs.readFile(file,'utf8')!==token)throw Error('Launch gate ownership changed');await fs.unlink(file)}
}
export async function readLaunchStop(root, identity, goalId) {
  let request=JSON.parse(await fs.readFile(path.join(root,'operator-stop-request.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return 'null';throw error}))
  if(!request){const early=(await fs.readFile(path.join(root,'stop-before-admission'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error})).trim();if(early)request={scope:'prelaunch',runId:identity.run_id,actorId:identity.actor_id,source:identity.source,epoch:identity.epoch,reason:early}}
  return operatorStopReason(request,{runId:identity.run_id,actorId:identity.actor_id,goalId,source:identity.source,epoch:identity.epoch,launchControlId:identity.control_id})
}
export async function beginColdIntake({root,logs,identity,giveStarter,prepareIntake,submitObjective}) {
  const control={...identity,goal_id:null,control_id:crypto.randomUUID(),helper_root:root,phase:'before_starter'}
  const file=path.join(logs,'e2e-launch-control.json')
  const checkStop=async()=>{
    const reason=await readLaunchStop(root,control)
    if(reason)throw Object.assign(Error('Launch canceled before intake'),{code:'launch_canceled',reason,run_id:control.run_id,no_goal:true})
  }
  let starter
  await withLaunchGate(root,async()=>{
    // Durable control ownership exists before any starter or request. Host stop
    // writers use this same gate, so intake and cancellation have one order.
    await fs.writeFile(file,JSON.stringify(control,null,2),{flag:'wx'})
    await checkStop()
    starter=await giveStarter()
  })
  await prepareIntake(starter)
  let response
  await withLaunchGate(root,async()=>{
    await checkStop()
    control.phase='intake_pending'
    const temp=file+'.new';await fs.writeFile(temp,JSON.stringify(control,null,2));await fs.rename(temp,file)
    response=await submitObjective()
  })
  return {control,starter,response}
}
