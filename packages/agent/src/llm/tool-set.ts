import { constructionIntentTool } from './construction-intent-tool'
import { findConstructionSitesTool } from './construction-site-tool'
import { solveProductionTool } from './production-planning-tool'
import { getProductionScopeTool } from './production-scope-tool'
import { tools } from './tools'
import { getTransportCapacityTool } from './transport-capacity-tool'

export const agentTools = [...tools, getProductionScopeTool, solveProductionTool, getTransportCapacityTool, findConstructionSitesTool, constructionIntentTool]
