import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {configuration} from '/candidate/deploy/pterodactyl/runtime-v8/supervisor.mjs';
import {resolveAgentRole} from '/candidate/deploy/pterodactyl/runtime-v8/agent-roles.mjs';
import {verifyCliProxyProviderContracts,providerRequest} from '/candidate/deploy/pterodactyl/runtime-v8/provider.mjs';
import * as policy from '/candidate/deploy/pterodactyl/runtime-v8/structured-policy.mjs';
import {verifyConfiguredCliProxyProviderContract} from './provider-contract-preflight.mjs';
import {verifyProtocol3Contracts} from './protocol3-provider-preflight.mjs';
import * as profile from './model-profile.mjs';
import {frozenModels} from './frozen-models.mjs';
const luna={planner:'gpt-6-luna',executor:'gpt-6-luna',overwatch:'gpt-6-luna'};
const env=models=>({AI_API_METHOD:'cli-proxy',OPENAI_MODEL:`${models.planner},${models.executor}`,OPENAI_API_BASEURL:'https://offline.invalid/v1',OPENAI_API_KEY:'never-send-fixture',TYPESAFE_API_KEY:'offline-fixture'});
for(const models of [profile.defaultModels,{...luna,planner:'gpt-6.1-sol'},luna])test(`real configuration/closed tools/protocol3 preserve BOTH roles: ${models.planner}/${models.executor}`,async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('External network forbidden');};
  try{
    const config=configuration({},env(models));
    assert.deepEqual(profile.assertConfiguredModels(models,config,resolveAgentRole),['planner','executor'].map(role=>({role,model:models[role]})));
    const proof=await verifyConfiguredCliProxyProviderContract(config,{verifyCliProxyProviderContracts,requestId:'frozen-profile',frozenModels:models});
    assert.deepEqual(proof.roles.map(r=>({role:r.role,model:r.model})),['planner','executor'].map(role=>({role,model:models[role]})));
    const protocol=await verifyProtocol3Contracts(config,{providerRequest,resolveAgentRole,policy});assert.equal(protocol.probes.length,8);
    assert.equal(calls,0);
    const registry=[...new Set(Object.values(models))];const roles=profile.assertCatalogModels(models,registry);assert.equal(roles.length,2);
    if(models===luna){assert.deepEqual(registry,['gpt-6-luna']);assert.throws(()=>profile.assertCatalogModels(models,['gpt-6.1-sol']),/absent/);}
    for(const role of ['planner','executor']){
      assert.equal(profile.roleResponseMismatch(models,{role,model:models[role]}),false);
      assert.equal(profile.roleResponseMismatch(models,{role,model:'unapproved'}),true);
      const bad={...config,models:[models.planner,models.executor]};bad.models[role==='planner'?0:1]='wrong';
      assert.throws(()=>profile.assertConfiguredModels(models,bad,resolveAgentRole),new RegExp(`Frozen ${role} model mismatch`));
      await assert.rejects(verifyConfiguredCliProxyProviderContract(bad,{verifyCliProxyProviderContracts,requestId:'wrong-role',frozenModels:models}),new RegExp(`Frozen ${role} model mismatch`));
    }
    assert.equal(profile.roleResponseMismatch(models,{role:'initial_planner_unattributed',model:'wrong'}),true);
    await assert.rejects(verifyConfiguredCliProxyProviderContract(config,{requestId:'wrong-proof',frozenModels:models,verifyCliProxyProviderContracts:async()=>({...proof,request_id:'wrong-proof',roles:proof.roles.map(r=>({...r,role:'planner'}))})}),/invalid/);
  }finally{globalThis.fetch=original;}
});

// Actual deployment and supervisor entry scripts. Filesystem, package/native/RCON
// and catalog transport are explicit substitutes; config/role/probe serializers
// are the REAL candidate modules. No world, provider, secrets or network exists.
async function entry(name,{wrongRole=false,catalog=['gpt-6-luna'],models=luna}={}){
  const source=await fs.readFile(new URL(`./${name}`,import.meta.url),'utf8');
  const expectedCandidate=source.match(/report.candidate!=='([^']+)'/)?.[1]??'offline-candidate';
  const seed=Number(source.match(/native.seed,(\d+)/)?.[1]??2026102501);
  const runId=source.match(/SGLUNA_E2E_RUN_ID,'([^']+)'/)?.[1]??'offline-run';
  const out=new Map();let tick=0,catalogCalls=0;
  const native=()=>({seed,humans:0,speed:1,board:null,machine_count:0,inventory:[],crafting_queue:[],actor_id:42,tick:tick+=120,operations:{task_state:'idle',queue_empty:true,queue_length:0,actor:{actor_id:42,mining_state:{mining:false}},follow:{active:false,navigation:{active:false}}}});
  const control='offline-native-fixture';const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
  const fakeFs={realpath:async()=>'/release/start-sgluna.sh',mkdir:async()=>{},readdir:async dir=>dir==='/data/.sgluna'?['run-offline']:dir==='/data/logs'?[]:dir.includes('autorio')?[{name:'control.lua',isDirectory:()=>false}]:[],
    readFile:async file=>{
      if(file==='/e2e/expected-runtime.json')return '[]';if(file==='/data/sgluna-config.json')return '{}';
      if(file==='/opt/sgluna/SOURCE_SHA'||file==='/e2e/candidate-sha.txt')return expectedCandidate;
      if(file==='/e2e/expected-prompt-sha256.txt')return hash('fixture-prompt');
      if(file.endsWith('/src/prompt.md'))return 'fixture-prompt';if(file.endsWith('/control.lua'))return control;
      if(file==='/data/.sgluna/npc-state.json')return '{}';if(file==='/e2e/snapshot.lua')return 'fixture-snapshot';throw Error('Unexpected fixture read '+file);},
    writeFile:async(file,body)=>{out.set(file,JSON.parse(body));}};
  class Rcon{async connect(){}close(){}async command(command){return JSON.stringify(command==='fixture-snapshot'?native():{actor_id:42,walking:false,mining:false,crafting_queue_length:0,starter_given:false});}}
  const selectedEnv={...env(models),SGLUNA_E2E_PROFILE:'normal',SGLUNA_E2E_RUN_ID:runId,SGLUNA_E2E_SOURCE_SHA:expectedCandidate};
  if(wrongRole)selectedEnv.OPENAI_MODEL='gpt-6.1-sol,gpt-6-luna';
  const context=vm.createContext({console:{log:()=>{}},process:{env:selectedEnv},performance:{now:()=>0},setTimeout:fn=>fn(),AbortSignal,fetch:async(_url,options)=>{catalogCalls++;return {status:options?.headers?200:401,json:async()=>({data:catalog.map(id=>({id}))})};}});
  const imports={'node:fs/promises':{default:fakeFs},'node:path':{default:path.posix},'node:crypto':{default:crypto},'node:assert/strict':{default:assert},'node:url':{pathToFileURL},'./frozen-models.mjs':{frozenModels:models},'./model-profile.mjs':profile,'./provider-contract-preflight.mjs':{verifyConfiguredCliProxyProviderContract},'./protocol3-provider-preflight.mjs':{verifyProtocol3Contracts}};
  async function mod(exports){const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v);},{context});await m.link(()=>{});await m.evaluate();return m;}
  const dynamic={ 'supervisor.mjs':{configuration,verifyManifest:async()=>{}},'agent-roles.mjs':{resolveAgentRole},'provider.mjs':{verifyCliProxyProviderContracts,providerRequest},'structured-policy.mjs':policy,'common.mjs':{Rcon},'observation-rate.mjs':{OBSERVATION_RATE:{burst:4,refillMs:15000}},'step-completion.mjs':{authoredCompletionContractSupported:()=>true}};
  const script=new vm.SourceTextModule(source,{context,importModuleDynamically:url=>{if(String(url)==='node:url')return mod({pathToFileURL});const name=path.posix.basename(String(url));assert.ok(dynamic[name],name);return mod(dynamic[name]);}});
  await script.link(spec=>{assert.ok(imports[spec],spec);return mod(imports[spec]);});await script.evaluate();
  return {out,catalogCalls};
}
test('actual rendered deployment verifier proves Luna/Luna config and both serializer roles; wrong effective planner fails',async()=>{
  const {out}=await entry('verify-deployment.mjs');const proof=out.get('/data/logs/deployment-verification.json');
  assert.deepEqual(proof.frozen_models,luna);assert.deepEqual(proof.effective_role_models,[{role:'planner',model:'gpt-6-luna'},{role:'executor',model:'gpt-6-luna'}]);assert.equal(proof.provider_contract_roles.length,2);
  await assert.rejects(entry('verify-deployment.mjs',{wrongRole:true}),/Frozen planner model mismatch/);
});
test('actual rendered supervisor preflight accepts Luna-only catalog with both roles; rejects wrong config and missing model',async()=>{
  const {out,catalogCalls}=await entry('supervisor-preflight.mjs');const proof=out.get('/data/logs/supervisor-preflight-proof.json');assert.equal(catalogCalls,2);
  assert.equal(proof.catalog.roles.length,2);assert.deepEqual(proof.catalog.roles.map(r=>r.model),['gpt-6-luna','gpt-6-luna']);
  await assert.rejects(entry('supervisor-preflight.mjs',{wrongRole:true}),/Frozen planner model mismatch/);
  await assert.rejects(entry('supervisor-preflight.mjs',{catalog:['gpt-6.1-sol']}),/Frozen planner model absent/);
});
test('Terra/Luna deployment and cold preflight bind exact roles and refuse a catalog without Terra',async()=>{
  const models=profile.defaultModels,catalog=[models.planner,models.executor];
  const {out}=await entry('verify-deployment.mjs',{models,catalog});
  assert.deepEqual(out.get('/data/logs/deployment-verification.json').effective_role_models,['planner','executor'].map(role=>({role,model:models[role]})));
  const {out:preflight}=await entry('supervisor-preflight.mjs',{models,catalog});
  assert.deepEqual(preflight.get('/data/logs/supervisor-preflight-proof.json').catalog.roles.map(r=>r.model),catalog);
  await assert.rejects(entry('supervisor-preflight.mjs',{models,catalog:['gpt-6.1-sol','gpt-6-luna']}),/Frozen planner model absent/);
  await assert.rejects(entry('verify-deployment.mjs',{models,catalog,wrongRole:true}),/Frozen planner model mismatch/);
});
test('rendered module selects approved frozen roles, independently of runtime configuration',()=>{assert.deepEqual(profile.validateFrozenModels(frozenModels),frozenModels);});
