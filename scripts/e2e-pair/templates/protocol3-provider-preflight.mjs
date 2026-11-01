import assert from 'node:assert/strict';

export async function verifyProtocol3Contracts(config, {providerRequest, resolveAgentRole, policy}) {
  const proofs=[];
  for(const role of ['planner','executor']) for(const allowTools of [true,false]) for(const compact of [true,false]) {
    let body;
    const resolved=resolveAgentRole(config,role);
    await providerRequest({...resolved,base:'https://offline.example.test/v1',key:'offline-fixture-only'},[
      {role:'system',content:'Offline role contract verification.'},
      {role:'user',content:compact?'[MOD] Autorio operation batch completed.':'[CHAT] Louis: offline contract check'},
    ],{role,completionProtocolVersion:3,allowTools,promptTraceFile:null,
      fetchImpl:async(_url,options)=>{
        body=JSON.parse(options.body);
        return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{}'}}]}),{status:200,headers:{'content-type':'application/json'}});
      }});
    assert.equal(body.model,resolved.model);
    assert.equal(body.tool_choice,allowTools?'auto':'none');
    const definitions=role==='planner'?policy.planningOnlyProviderToolDefinitions:policy.executionOnlyProviderToolDefinitions;
    // Production compacts human descriptions; all schema keys and bounds must remain exact.
    const schema=value=>JSON.parse(JSON.stringify(value,(key,item)=>key==='description'?undefined:item));
    assert.deepEqual(schema(body.tools),schema(definitions),'Actual protocol 3 tools differ from released role definitions');
    const names=body.tools.map(tool=>tool.function.name);
    assert.equal(new Set(names).size,names.length);
    const control=body.tools.find(tool=>tool.function.name==='submitPlan').function.parameters.properties;
    if(role==='planner') {
      assert.equal(control.operations.maxItems,0,'Planner must refuse gameplay operations');
      assert.ok(control.executionGuidance);
      assert.match(body.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n'),/ROLE: PLANNER/);
    } else {
      assert.equal(control.operations.maxItems,16);
      assert.ok(control.plannerReview);
      for(const key of ['plan','goal','roadmap','executionGuidance']) assert.equal(control[key],undefined);
    }
    proofs.push({role,model:body.model,allow_tools:allowTools,compact,completion_protocol_version:3,tool_count:names.length,tool_names:names,role_contract_verified:true});
  }
  return {status:'pass',external_inference_calls:0,completion_protocol_version:3,probes:proofs};
}
