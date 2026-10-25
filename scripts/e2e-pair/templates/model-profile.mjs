// Explicit trial allowlist. This is not provider auto-detection or a mismatch waiver.
export const defaultModels = Object.freeze({planner:'gpt-6.1-sol',executor:'gpt-6-luna',overwatch:'gpt-6-luna'});
export function validateFrozenModels(models) {
  if (!models || Object.keys(models).sort().join(',') !== 'executor,overwatch,planner'
    || !['gpt-6.1-sol','gpt-6-luna'].includes(models.planner)
    || models.executor !== 'gpt-6-luna' || models.overwatch !== 'gpt-6-luna') throw Error('Unapproved frozen role model profile');
  return {...models};
}
export function assertConfiguredModels(models, config, resolveAgentRole) {
  validateFrozenModels(models);
  if (config?.aiApiMethod !== 'cli-proxy' || config?.profile !== 'cli-proxy') throw Error('Frozen roles require explicit CLI-proxy configuration');
  const roles = ['planner','executor'].map(role=>({role,model:resolveAgentRole(config,role).model}));
  for (const row of roles) if (row.model !== models[row.role]) throw Error(`Frozen ${row.role} model mismatch`);
  return roles;
}
export function assertCatalogModels(models, ids) {
  validateFrozenModels(models);
  return ['planner','executor'].map(role=>{
    if (!ids.includes(models[role])) throw Error(`Frozen ${role} model absent from catalog`);
    return {role,model:models[role],present:true};
  });
}
export function roleResponseMismatch(models, response) {
  // Older initial planner response traces have no explicit role; they still use
  // the frozen planner. Keep each explicit role even for a shared model ID.
  const role = response.role === 'initial_planner_unattributed' ? 'planner' : response.role;
  return Boolean(response.model && ['planner','executor'].includes(role) && response.model !== models[role]);
}
