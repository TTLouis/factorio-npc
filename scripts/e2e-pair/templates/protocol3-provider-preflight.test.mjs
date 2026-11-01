import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocol3Contracts} from './protocol3-provider-preflight.mjs';
import {providerRequest} from '/candidate/deploy/pterodactyl/runtime-v8/provider.mjs';
import {resolveAgentRole} from '/candidate/deploy/pterodactyl/runtime-v8/agent-roles.mjs';
import * as policy from '/candidate/deploy/pterodactyl/runtime-v8/structured-policy.mjs';
const config={profile:'cli-proxy',aiApiMethod:'cli-proxy',models:['gpt-6.1-sol','gpt-6-luna']};
test('actual CLI-proxy protocol 3 role serializers pass all eight offline probes',async()=>{
  const proof=await verifyProtocol3Contracts(config,{providerRequest,resolveAgentRole,policy});
  assert.equal(proof.probes.length,8);assert.equal(proof.external_inference_calls,0);
});
test('legacy action-capable planner schema fails the protocol 3 preflight',async()=>{
  await assert.rejects(verifyProtocol3Contracts(config,{resolveAgentRole,policy,
    providerRequest:(config,messages,options)=>providerRequest(config,messages,{...options,completionProtocolVersion:2})}));
});
