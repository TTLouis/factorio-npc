import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {verifyConfiguredCliProxyProviderContract} from './provider-contract-preflight.mjs';
import {verifyProtocol3Contracts} from './protocol3-provider-preflight.mjs';
const release=path.dirname(await fs.realpath('/opt/sgluna/start-sgluna.sh'));
const expected=JSON.parse((await fs.readFile('/e2e/expected-runtime.json','utf8')).replace(/^\uFEFF/,''));
const hash=text=>crypto.createHash('sha256').update(text.replaceAll('\r','')).digest('hex');
const mismatches=[]; const shipped=[];
for(const family of ['runtime-v8','staging']) {
 const names=(await fs.readdir(path.join(release,'src',family))).filter(n=>n.endsWith('.mjs'));
 for(const name of names) {shipped.push(`${family}/${name}`);const exp=expected.find(e=>e.family===family&&e.name===name);if(!exp||hash(await fs.readFile(path.join(release,'src',family,name),'utf8'))!==exp.sha256)mismatches.push(`${family}/${name}`);}
}
for(const e of expected)if(!shipped.includes(`${e.family}/${e.name}`))mismatches.push(`missing:${e.family}/${e.name}`);
const runs=(await fs.readdir('/data/.sgluna')).filter(n=>n.startsWith('run-'));if(runs.length!==1)throw Error('Expected one fresh run workspace');
const active=`/data/.sgluna/${runs[0]}/mods/autorio_0.1.0`;
const files=async(dir,prefix='')=>{const out=[];for(const d of await fs.readdir(path.join(dir,prefix),{withFileTypes:true})){const p=path.join(prefix,d.name);if(d.isDirectory())out.push(...await files(dir,p));else out.push(p);}return out;};
const modFiles=await files(path.join(release,'autorio'));const activeFiles=await files(active);const modMismatches=[];
for(const file of modFiles)if(!activeFiles.includes(file)||crypto.createHash('sha256').update(await fs.readFile(path.join(release,'autorio',file))).digest('hex')!==crypto.createHash('sha256').update(await fs.readFile(path.join(active,file))).digest('hex'))modMismatches.push(file);
for(const file of activeFiles)if(!modFiles.includes(file))modMismatches.push(`extra:${file}`);
const config=JSON.parse(await fs.readFile('/data/sgluna-config.json','utf8'));
const {configuration}=await import((await import('node:url')).pathToFileURL(path.join(release,'src/runtime-v8/supervisor.mjs')));
const {resolveAgentRole}=await import((await import('node:url')).pathToFileURL(path.join(release,'src/runtime-v8/agent-roles.mjs')));
const roles=configuration(config,process.env);
const {verifyCliProxyProviderContracts}=await import((await import('node:url')).pathToFileURL(path.join(release,'src/runtime-v8/provider.mjs')));
const providerContract=await verifyConfiguredCliProxyProviderContract(roles,{verifyCliProxyProviderContracts,requestId:'run_aj_provider_contract_preflight'});
await fs.mkdir('/data/logs',{recursive:true});
await fs.writeFile('/data/logs/provider-contract-preflight.json',JSON.stringify(providerContract,null,2));
const policy=await import((await import('node:url')).pathToFileURL(path.join(release,'src/runtime-v8/structured-policy.mjs')));
const {providerRequest}=await import((await import('node:url')).pathToFileURL(path.join(release,'src/runtime-v8/provider.mjs')));
const protocol3=await verifyProtocol3Contracts(roles,{providerRequest,resolveAgentRole,policy});
await fs.writeFile('/data/logs/protocol3-contract-proof.json',JSON.stringify(protocol3,null,2));
const toolCatalogProof=providerContract.roles.map(row=>{
  const expectedNames=(row.role==='executor'?policy.executorProviderToolDefinitions:policy.providerToolDefinitions).map(tool=>tool.function.name).sort();
  const actualNames=row.body.tools.map(tool=>tool.function.name).sort();
  if(JSON.stringify(actualNames)!==JSON.stringify(expectedNames)||new Set(actualNames).size!==actualNames.length)throw Error(`Actual ${row.role} closed tool catalog differs from released role schema`);
  if(!actualNames.includes('getPumpSitePreparation'))throw Error('Released landfill preparation observation tool absent');
  return {role:row.role,count:actualNames.length,names:actualNames,complete_role_catalog_match:true};
});
if(!policy.approvedOperationNames().includes('prepare_pump_site'))throw Error('Released landfill preparation action absent');
await fs.writeFile('/data/logs/full-tool-catalog-proof.json',JSON.stringify({source:(await fs.readFile('/opt/sgluna/SOURCE_SHA','utf8')).trim(),roles:toolCatalogProof,prepare_pump_site_action:true,external_inference_calls:0},null,2));
const planner=resolveAgentRole(roles,'planner').model;
const executor=resolveAgentRole(roles,'executor').model;
if(planner!=='gpt-6.1-sol'||executor!=='gpt-6-luna')throw Error('Unexpected role model selection');
console.log(JSON.stringify({planner_model:planner,executor_model:executor}));
const report={candidate:(await fs.readFile('/opt/sgluna/SOURCE_SHA','utf8')).trim(),runtime_modules_compared:shipped.length,mismatches,mod_files_compared:modFiles.length,mod_mismatches:modMismatches,active_control_sha256:hash(await fs.readFile(path.join(active,'control.lua'),'utf8')),model:process.env.OPENAI_MODEL,effective_ai_api_method:roles.aiApiMethod,effective_provider_profile:roles.profile,provider_contract_status:providerContract.status,provider_contract_external_inference_calls:providerContract.external_inference_calls,provider_contract_roles:providerContract.roles.map(r=>({role:r.role,model:r.model,profile:r.profile,model_family:r.capabilities.model_family,tools_kept_when_closed:r.capabilities.tools_kept_when_closed,closed_tool_choice:r.body.tool_choice,closed_tool_count:r.body.tools.length})),jev_token_present:Boolean(process.env.TYPESAFE_API_KEY?.trim()),config_model:config.model??config.providerModel??null};
await fs.mkdir('/data/logs',{recursive:true});await fs.writeFile('/data/logs/deployment-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(mismatches.length||modMismatches.length||!report.jev_token_present||report.candidate!=='@@CANDIDATE@@')process.exitCode=1;

if(hash(await fs.readFile(path.join(release,'src/prompt.md'),'utf8'))!==(await fs.readFile('/e2e/expected-prompt-sha256.txt','utf8')).trim())throw Error('Packaged prompt differs from candidate');
const {verifyManifest}=await import((await import('node:url')).pathToFileURL(path.join(release,'src/runtime-v8/supervisor.mjs')));await verifyManifest(release);console.log('PASS prompt source and release manifest');


const {OBSERVATION_RATE}=await import((await import('node:url')).pathToFileURL(path.join(release,'src/runtime-v8/observation-rate.mjs')));
if(OBSERVATION_RATE.burst!==4||OBSERVATION_RATE.refillMs!==15000)throw Error('Observation rate differs from the frozen candidate');
const nativeInterfaces=await import((await import('node:url')).pathToFileURL(path.join(release,'src/runtime-v8/step-completion.mjs')));
if(!nativeInterfaces.authoredCompletionContractSupported({mode:'all',requirements:[{kind:'area_reservation_state',reservation_id:1,revision:1,expected:'reserved'}]}))throw Error('Released reservation checkpoint missing');
await fs.writeFile('/data/logs/new-feature-contract-proof.json',JSON.stringify({observation_rate:OBSERVATION_RATE,reservation_tools:['validateConstructionReservation','getConstructionReservations','getReservationDesignInput'].every(name=>policy.toolDefinitions.some(tool=>tool.function.name===name)),reservation_operation:policy.approvedOperationNames().includes('reserve_construction_area'),reservation_checkpoint:true,external_inference_calls:0},null,2));
