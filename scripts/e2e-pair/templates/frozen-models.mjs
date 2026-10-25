import {validateFrozenModels} from './model-profile.mjs';
export const frozenModels = Object.freeze(validateFrozenModels({planner:'@@PLANNER_MODEL@@',executor:'@@EXECUTOR_MODEL@@',overwatch:'@@OVERWATCH_MODEL@@'}));
export const overwatchReasoning = 'low';
