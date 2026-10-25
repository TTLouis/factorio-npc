// Gate only this explicit CLI-proxy trial. No provider auto-detection.
export async function verifyConfiguredCliProxyProviderContract(config, { verifyCliProxyProviderContracts, requestId }) {
  if (typeof verifyCliProxyProviderContracts !== 'function') throw Error('Deployed CLI-proxy contract probe export is missing');
  const proof = await verifyCliProxyProviderContracts(config, { requestId });
  if (config?.aiApiMethod !== 'cli-proxy' || config?.profile !== 'cli-proxy'
    || proof?.event !== 'provider.cli_proxy_contract_verified' || proof.request_id !== requestId
    || proof.reason !== 'explicit_cli_proxy_method_and_role_closed_wire_verified' || proof.status !== 'pass'
    || proof.ai_api_method !== 'cli-proxy' || proof.external_inference_calls !== 0
    || !Array.isArray(proof.roles) || proof.roles.length !== 2) throw Error('CLI-proxy contract preflight proof is incomplete');
  for (const [index, role] of ['planner', 'executor'].entries()) {
    const expectedModel = config.models?.[index] ?? config.models?.[0] ?? config.model;
    const row = proof.roles.find(entry => entry.role === role);
    if (row?.model !== expectedModel || row.profile !== 'cli-proxy' || row.capabilities?.id !== 'cli-proxy'
      || row.capabilities.model_family !== 'openai-gpt' || row.capabilities.tools_kept_when_closed !== true
      || row.capabilities.tool_support !== true || row.body?.model !== expectedModel || row.body.tool_choice !== 'none'
      || !Array.isArray(row.body.tools) || row.body.tools.length === 0
      || !row.body.tools.every(tool => tool.type === 'function')
      || !row.body.tools.some(tool => tool.function?.name === 'submitPlan')) throw Error(`CLI-proxy ${role} closed-body proof is invalid`);
  }
  return proof;
}
