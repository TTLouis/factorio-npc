import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {verifyConfiguredCliProxyProviderContract as gate} from './provider-contract-preflight.mjs';
import {configuration} from '/candidate/deploy/pterodactyl/runtime-v8/supervisor.mjs';
import {verifyCliProxyProviderContracts,providerCapabilityProfile} from '/candidate/deploy/pterodactyl/runtime-v8/provider.mjs';

const requestId='run_z_provider_contract_preflight';
const env={AI_API_METHOD:'cli-proxy',OPENAI_API_BASEURL:'http://localhost:18317/v1',OPENAI_API_KEY:'fixture-never-send-key',OPENAI_MODEL:'gpt-6.1-sol,gpt-6-luna'};
const config=()=>configuration({},env);
const verify=value=>gate(value,{verifyCliProxyProviderContracts,requestId});

test('actual configured CLI-proxy planner/executor serializers pass offline without external fetch or secret/endpoint proof',async()=>{
  const originalFetch=globalThis.fetch;let network=0;
  globalThis.fetch=async()=>{network++;throw Error('external fetch forbidden in preflight');};
  try{
    const effective=config();
    assert.equal(effective.aiApiMethod,'cli-proxy');assert.equal(effective.profile,'cli-proxy');
    const proof=await verify(effective);
    assert.equal(proof.external_inference_calls,0);assert.equal(network,0);
    assert.deepEqual(proof.roles.map(r=>[r.role,r.model,r.profile,r.body.tool_choice]),[['planner','gpt-6.1-sol','cli-proxy','none'],['executor','gpt-6-luna','cli-proxy','none']]);
    const serialized=JSON.stringify(proof);
    assert.equal(serialized.includes(env.OPENAI_API_KEY),false);assert.equal(serialized.includes(env.OPENAI_API_BASEURL),false);
  }finally{globalThis.fetch=originalFetch;}
});

test('actual probe rejects unset/empty/direct/router methods and generic or unsupported role contracts',async()=>{
  for(const method of [undefined,'','direct','router','local']){
    await assert.rejects(verify({...config(),aiApiMethod:method}),/requires AI_API_METHOD=cli-proxy/);
  }
  await assert.rejects(verify({...config(),profile:'auto'}),/planner requires the CLI-proxy GPT closed-tool contract/);
  await assert.rejects(verify({...config(),profile:'generic'}),/planner requires the CLI-proxy GPT closed-tool contract/);
  await assert.rejects(verify({...config(),models:['claude-opus-4','gpt-6-luna']}),/planner requires the CLI-proxy GPT closed-tool contract/);
  await assert.rejects(verify({...config(),models:['gpt-6.1-sol','claude-opus-4']}),/executor requires the CLI-proxy GPT closed-tool contract/);
});

test('Run U empty method remains generic and is rejected rather than globally reclassified',async()=>{
  const effective=configuration({}, {...env,AI_API_METHOD:''});
  assert.equal(effective.aiApiMethod,undefined);
  assert.equal(providerCapabilityProfile(effective).id,'generic');
  await assert.rejects(verify(effective),/requires AI_API_METHOD=cli-proxy/);
});

test('gate rejects missing/incomplete/miscorrelated or inferred proof before actual-container READY',async()=>{
  await assert.rejects(gate(config(),{requestId}),/probe export is missing/);
  const original=await verify(config());
  const changes=[
    p=>p.status='failed',p=>p.external_inference_calls=1,p=>p.request_id='wrong-request',p=>p.ai_api_method='',
    p=>p.roles.pop(),p=>p.roles[1].role='planner',p=>p.roles[1].model='wrong-model',
    p=>p.roles[1].profile='generic',p=>p.roles[1].capabilities.model_family='other',
    p=>p.roles[1].capabilities.tools_kept_when_closed=false,p=>p.roles[1].body.tool_choice='auto',
    p=>delete p.roles[1].body.tools,p=>p.roles[1].body.tools=[],
    p=>p.roles[1].body.tools=[{type:'function',function:{name:'other'}}],
  ];
  for(const edit of changes){const proof=structuredClone(original);edit(proof);await assert.rejects(gate(config(),{requestId,verifyCliProxyProviderContracts:async()=>proof}),/proof.*(incomplete|invalid)/);}
});

test('isolated overlay explicitly selects CLI-proxy and deployed gate uses effective configuration and real probe',async()=>{
  const overlay=await fs.readFile(new URL('./live.compose.yml',import.meta.url),'utf8');
  assert.equal(/^\s+AI_API_METHOD:\s*"cli-proxy"\s*$/m.test(overlay),true);
  const source=await fs.readFile(new URL('./verify-deployment.mjs',import.meta.url),'utf8');
  assert.match(source,/configuration\(config,process\.env\)/);
  assert.match(source,/providerContract=await verifyConfiguredCliProxyProviderContract\(roles/);
  assert.match(source,/effective_ai_api_method:roles.aiApiMethod/);
  assert.match(source,/effective_provider_profile:roles.profile/);
  assert.doesNotMatch(source,/config_api_method:config.apiMethod/);
});
