// State scopes of the NPC loop (delegation unit A3).
//
// NpcAgentLoop holds ~200 instance fields and each has an implicit lifetime. The
// conversation in `messages` is replaced many times in a run (restage, planner
// resume, reasoning-epoch rebuild, slice continuation, capsule fallback,
// compaction, reset), so a field whose lifetime silently assumes one continuous
// conversation goes stale at the swap. This module names every field's scope,
// lists the swap sites, and reports which swap site resets which
// conversation/decision-scoped field. The registry is lint-enforced by
// state-scopes.test.mjs; the reset matrix is a report (unit B makes it strict).
//
// Pure: node builtins only. Run `node state-scopes.mjs --report [--json]`.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { LIFECYCLE_SITES, lifecycleResets } from './lifecycle.mjs'

export const STATE_SCOPES = Object.freeze([
  'construction', // injected deps/config/options, set once in the constructor
  'process', // stable game/prototype data valid for this server runtime
  'actor_epoch', // valid for one actor/epoch snapshot
  'request', // one chat request lineage; reset by reset()
  'conversation', // only valid for the conversation now in `messages`; reset or re-deliver when it is replaced
  'decision', // one model decision / observation phase
  'step', // one plan step
  'goal', // one goal
  'turn', // one runTurn
  'telemetry', // counters/trace/usage that never reach the model
])

const V8 = 'runtime-v8/npc-agent-loop'
const ST = 'staging/npc-agent-loop'
const ADAPTER = 'runtime-v8/supervisor-adapter'
const GOALREQ = 'runtime-v8/goal-requirements'
const SKILLS = 'runtime-v8/skill-offers'
const SUPERVISOR = 'runtime-v8/supervisor'

const f = (scope, model_visible, owner, note) => Object.freeze({ scope, model_visible, owner, note })

export const LOOP_STATE_FIELDS = Object.freeze({
  // --- construction: injected dependencies, options and config -------------------------------------------------
  rcon: f('construction', false, ST, 'RCON transport injected in the staging constructor'),
  provider: f('construction', false, ST, 'provider adapter injected in the staging constructor'),
  systemPrompt: f('construction', true, ST, 'base system prompt; role prefixes are derived from it in rolePrefixMessages'),
  reserve: f('construction', false, ST, 'reserve hook injected in the staging constructor'),
  log: f('construction', false, ST, 'log sink injected in the staging constructor'),
  maxToolRounds: f('construction', false, ST, 'round cap option, never reassigned'),
  maxContinuations: f('construction', false, ST, 'continuation cap option, never reassigned'),
  maxToolLoopRetries: f('construction', false, ST, 'option, never reassigned'),
  maxToolValidationRetries: f('construction', false, ST, 'option, never reassigned (goal-requirements reads it)'),
  maxRecoveryAttempts: f('construction', false, ST, 'option, never reassigned'),
  memory: f('construction', true, ST, 'dialogue memory facade; its own state is durable, not conversation state'),
  npcId: f('construction', false, ST, 'NPC identity option'),
  memoryKeyForStatus: f('construction', false, ST, 'memory key resolver option'),
  stateFile: f('construction', false, V8, 'durable state path from options'),
  completionProtocolVersion: f('construction', true, V8, 'protocol version from options; selects prompts in rolePrefixMessages, set once'),
  maxProviderOutputUnits: f('construction', false, V8, 'per-generation output cap option'),
  maxProviderBudgetHandoffs: f('construction', false, V8, 'budget handoff cap option'),
  explicitWorkingCeiling: f('construction', false, V8, 'true when maxWorking* options were passed'),
  defaultWorkingCeiling: f('construction', false, V8, 'default compaction ceiling captured in the constructor'),
  interactionProvider: f('construction', false, V8, 'injected provider option'),
  interactionDecisionProvider: f('construction', false, V8, 'Jev decision provider wrapped by recordedDecisionProvider, set once'),
  steeringDecisionProvider: f('construction', false, V8, 'Jev decision provider wrapped by recordedDecisionProvider, set once'),
  operationProjectionDecisionProvider: f('construction', false, V8, 'Jev decision provider wrapped by recordedDecisionProvider, set once'),
  skillDecisionProvider: f('construction', false, V8, 'Jev decision provider wrapped by recordedDecisionProvider, set once'),
  goalDefinitionPolicy: f('construction', true, V8, 'required/optional goal definition policy from options'),
  goalSampling: f('construction', false, V8, 'goal check sampling option'),
  onActivity: f('construction', false, V8, 'activity callback option'),
  behaviorTrace: f('construction', false, V8, 'trace writer built in the constructor'),
  decisionTrace: f('construction', false, V8, 'decision trace writer built in the constructor'),
  jev: f('construction', true, V8, 'JevCheckpoints object built once; its hints/facts reach restage packets (own state is in jev-checkpoints.mjs)'),
  executorHandoffEnabled: f('construction', true, V8, 'executorHandoff option; gates the planner/executor handoff'),
  replacementWakeEnabled: f('construction', true, V8, 'replacementWake option set by the supervisor'),
  restageSoftLimitOption: f('construction', false, V8, 'restage soft limit option'),
  _agentContext: f('construction', true, V8, 'lazy holder (agentContext getter) created once; its content is the conversation, tracked as messages/baseMessages and the agentContext swap calls'),
  turnScope: f('construction', false, V8, 'AsyncLocalStorage created once; its store is the running turn identity'),

  // --- process: stable data that outlives requests --------------------------------------------------------------
  staticPrototypeCache: f('process', true, ST, 'prototype facts LRU, kept by reset() via ??=; a hit skips the RCON read (handleToolBatch)'),
  maxWorkingChars: f('process', true, ST, 'staging constructor option; v8 applyContextWindowCeiling rewrites it from the provider profile (compaction threshold)'),
  maxWorkingMessages: f('process', true, ST, 'staging constructor option; v8 applyContextWindowCeiling rewrites it from the provider profile (compaction threshold)'),
  workingCeiling: f('process', true, V8, 'compaction ceiling object, rewritten only by applyContextWindowCeiling'),
  stateLoaded: f('process', false, V8, 'durable state restored once (loadPersistentState)'),
  persistQueue: f('process', false, V8, 'promise chain serialising durable writes'),
  turnSequence: f('process', false, ST, 'monotonic turn id; restored from memory in loadPersistentState'),
  planningReasoningEpochSeen: f('process', true, V8, 'reasoning epoch per plan key, never cleared; a bump triggers the planner rebuild in refreshPlanningReasoningEpoch (restageContext marks it seen)'),
  handoffRecipeFacts: f('process', true, V8, 'stable recipe facts, outlive requests (constructor comment); written in prefetchRecipeClosure'),
  handoffRecipeQueries: f('process', true, V8, 'recipe names already queried, stable data'),
  handoffRawLeaves: f('process', true, V8, 'raw-leaf items per recipe closure, stable data'),
  handoffBurnerFuels: f('process', true, V8, 'burner fuel items per category: stable prototype data'),
  handoffNoRecipeItems: f('process', true, V8, 'items the game answered "no recipe" for: stable data'),
  handoffPlacingItems: f('process', true, V8, 'entity prototype to placing item: stable prototype data'),
  handoffTriggerCraftingReports: f('process', true, V8, 'trigger-crafting reports merged by technology in recordRequirementsFacts, never cleared (ambiguous: research state, not strictly static)'),
  worldMutationSeq: f('process', true, V8, 'monotonic world-change sequence (noteWorldMutation) that orders observations; never reset'),
  topologyPrototypeFacts: f('process', true, V8, 'prototype details Map, dropped only when the epoch session changes (gatherTopologyContext)'),
  topologyPrototypeSession: f('process', false, V8, 'session id the topology prototype Map belongs to'),
  latestCompletedBatchId: f('process', false, V8, 'last completed batch id from inspectAuthoritativeRuntime; stamps Jev observation log entries'),
  latestGameTick: f('process', false, V8, 'max game tick seen from inspectAuthoritativeRuntime'),

  // --- actor_epoch ----------------------------------------------------------------------------------------------
  epoch: f('actor_epoch', true, ST, 'actor/epoch snapshot captured in request(), nulled by reset(), compared in assertCurrent; tags facts shown to the model'),

  // --- request: one chat request lineage -------------------------------------------------------------------------
  active: f('request', false, ST, 'request live flag: reset(), request(), cleared by terminal paths'),
  continuations: f('request', false, ST, 'request-wide continuation counter: reset() zeroes, continueFromModMessage/completed increment'),
  requestInfo: f('request', true, ST, 'sender/text/turnId built in request(), nulled by reset(); the epoch rebuild re-reads it to rebuild [CHAT]'),
  generation: f('request', false, ST, 'bumped by every reset(); the stale-turn fence used by runGuarded and callProvider'),
  planUpdateReason: f('request', true, V8, 'set in request(), completed(), failed(); names the planner trigger used for reasoning policy'),
  requestLifecycle: f('request', true, V8, 'intent of the request; set in request(), finalizeCompletedTaskContext, completed'),
  lastTaskStatusView: f('request', true, V8, 'latest world receipt of the request: cleared in request() and finalizeCompletedTaskContext; read for tick fences, observation tags and plan context. The diff baseline is taskStatusDiffBaseline'),
  lastHandledRuntimeReceipt: f('request', false, V8, 'receipt dedupe, cleared in request() and finalizeCompletedTaskContext'),
  lastRecoveryDecisionKey: f('request', false, V8, 'Jev recovery decision dedupe key; cleared only by cancel(), not reset() (ambiguous: a hit skips a Jev call, not text)'),
  lastRecoveryDecision: f('request', false, V8, 'last Jev recovery decision returned on a duplicate key; cleared only by cancel()'),
  pendingBlindWait: f('request', true, V8, 'blind wait awaiting its receipt facts; cleared by reset() and routeWaitOnlyBatch'),
  liveEntityObservations: f('request', true, V8, 'live entities seen this request: cleared in request() and finalizeCompletedTaskContext; feeds exact-target checks and handoff packets'),
  handoffInventoryObservations: f('request', true, V8, 'inventory observations: resetHandoffObservations (request(), completion); not by conversation swaps'),
  handoffTouchedItems: f('request', true, V8, 'items touched: resetHandoffObservations'),
  handoffRequirementMachines: f('request', true, V8, 'requirement machines: resetHandoffObservations'),
  batchInFlight: f('request', true, V8, 'operation batch sent, receipt unread: reset(), resetHandoffObservations, noteWorldMutation; defers executor facts and topology'),
  batchInFlightBeforeSend: f('request', false, V8, 'saved batchInFlight for a rejected send; cleared by reset()'),
  pendingExecutorFactsRefresh: f('request', true, V8, 'deferred executor counts: reset(), restageThrough, resetHandoffObservations; consumed in executorFactsRefreshText'),
  replacementWake: f('request', true, V8, 'MW5 wake belongs to the request that raised it (reset())'),
  sliceContinuationBaseline: f('request', false, V8, 'plan-slice continuation baseline; reset() and closeContinuationSlice'),
  sliceDeterministicCloses: f('request', false, V8, 'plan-slice deterministic close count; reset() and closeContinuationSlice'),
  sliceAdmittedBatches: f('request', false, V8, 'plan-slice admitted batch count; reset() and closeContinuationSlice'),
  rejectedExactTargets: f('request', false, V8, 'exact-target refusals: cleared in request() and finalizeCompletedTaskContext'),
  bootstrapDependencyPreflightRetries: f('request', true, V8, 'refusal retry budget: request() and finalizeCompletedTaskContext only'),
  requiresMachinePreflightRetries: f('request', true, V8, 'refusal retry budget: request() and finalizeCompletedTaskContext only'),
  authorizationRefusalRetries: f('request', true, V8, 'refusal retry budget: request() and finalizeCompletedTaskContext only'),
  duplicateEffectRetries: f('request', true, V8, 'refusal retry budget: request() only'),
  duplicateEffectHold: f('request', true, V8, 'duplicate-effect hold: request() and commitPlan'),
  lostAckRetries: f('request', true, V8, 'lost-ack retry budget: request() only'),
  unmetGoalContinuationUsed: f('request', true, V8, 'one unmet-goal continuation per request: request(), continueUnmetGoal'),
  inTurnSliceContinuations: f('request', false, V8, 'in-turn slice chain count: request(), continueFromModMessage'),
  pendingDroppedOperationsNote: f('request', true, V8, 'note shown after dropped operations: request(), continueUnmetGoal, commitPlan'),
  lastGoalEvaluation: f('request', false, V8, 'last goal evaluation: request(), evaluateGoalCompletion'),
  providerBudgetHandoffCount: f('request', false, V8, 'budget handoffs this request: request() from the plan, incremented in recoverPlanRoute'),
  providerBudgetStepMark: f('request', false, V8, 'goal and closed-step count the budget generation began at: request(), rollProviderBudgetAtStepClose'),
  lastMemoryKey: f('request', false, V8, 'memory key of the last request (request(), commitPlan)'),
  preMintedRequestId: f('request', false, V8, 'request id minted by recordInterruptedTask for the next request()'),
  chatRequestPending: f('request', false, V8, 'set in request(), consumed by runGuardedTurn'),
  startRestage: f('request', true, V8, 'pending C5 restage consumed by applyStartRestage; cleared in request() finally'),
  topologyObservation: f('request', true, V8, 'placement-candidate obstruction facts, valid only for the same generation and world mutation (currentTopologyFacts)'),

  // --- conversation: dies with the conversation in messages ------------------------------------------------------
  messages: f('conversation', true, V8, 'getter/setter over agentContext.messages; swapped by commitRestage/resumePlanner, rebuilt by the epoch refresh and continuation, assigned in staging reset/request'),
  baseMessages: f('conversation', true, V8, 'getter/setter over agentContext.baseMessages; same swap sites as messages'),
  toolCache: f('conversation', true, ST, 'B1: AgentContext conversation slot (v8 accessor), so every new conversation starts empty and a resumed planner gets its own back; a hit answers "Duplicate observation suppressed"; also cleared by completed/continueFromModMessage'),
  prototypeRefsThisRequest: f('conversation', true, ST, 'B1: AgentContext conversation slot (v8 accessor); drives prototypeUnchangedResult ("already in [STATIC_PROTOTYPE_CACHE]"), so after a swap a repeat read answers with full cached_static facts; prepareContinuationContext re-delivers it within a conversation'),
  pendingInteractionAmendment: f('conversation', true, V8, 'staged amendment text lives in baseMessages: reset() drops it, currentPendingAmendment drops it when conversationSeq moved on'),
  pendingAmendmentConversationSeq: f('conversation', true, V8, 'conversationSeq that holds the staged amendment text; reset(), restageContext (carried in the packet)'),
  executorStepMark: f('conversation', false, V8, 'closed-step count, checkpoint, handoff id and world-mutation count the executor conversation started at: set in restageContext, restored by foldReviewHandback, cleared by reset() and returnControlToPlanner'),
  topologyBoundary: f('conversation', true, V8, 'topology refresh cache whose key includes conversationSeq (gatherTopologyContext), so a swap forces a re-gather'),
  unchangedFactReads: f('conversation', true, V8, 'B1: AgentContext conversation slot (v8 accessor): records what this conversation received, so after a swap an identical read is charged again; a hit stops charging observation budget'),
  taskStatusDiffBaseline: f('conversation', true, V8, 'B1: AgentContext conversation slot (v8 accessor): the receipt the current conversation last showed; taskStatusDelta diffs against it, so a new conversation gets a full receipt'),
  entityStatusBaselines: f('conversation', true, ADAPTER, 'entity-status diff baselines: reset by the request wrapper, scoped by lineage+conversationSeq and evidence still in messages; prepareContinuationContext re-appends'),
  entityStatusBaselineOrder: f('conversation', true, ADAPTER, 'LRU order of entityStatusBaselines, reset with it by the request wrapper'),
  nearbyEntitiesBaselines: f('conversation', true, ADAPTER, 'nearby-entities diff baselines, same scope rules as entityStatusBaselines'),
  nearbyEntitiesBaselineOrder: f('conversation', true, ADAPTER, 'LRU order of nearbyEntitiesBaselines'),
  observationBaselineRepairs: f('conversation', true, ADAPTER, 'repair closures keyed by tool message objects, pruned when the message leaves messages (repairObservationBaselines)'),

  // --- decision: one model decision / observation phase ----------------------------------------------------------
  interactionAbort: f('decision', false, V8, 'abort handle of the in-flight interaction decision; cancel() clears it'),
  postStepDecisionAbort: f('decision', false, V8, 'abort handle of the in-flight post-step decision; cancel() clears it'),
  recoveryDecisionAbort: f('decision', false, V8, 'abort handle of the in-flight recovery decision; cancel() clears it'),
  operationProjectionAbort: f('decision', false, V8, 'abort handle of the in-flight projection decision; cancel() clears it'),
  skillChoiceAbort: f('decision', false, SKILLS, 'abort handle of the in-flight skill_choice Jev call (abortSkillChoice)'),
  skillChoicePending: f('decision', false, SKILLS, 'promise of the shadow skill_choice call'),
  reasoningTriggerSource: f('decision', true, V8, 'planner trigger for this decision; set and restored around request/completed/failed/recoverPlanRoute, nulled by cancel()'),
  reasoningBudgetOverride: f('decision', true, V8, 'reasoning budget for the next decision; saved and restored by request/completed/failed/recoverPlanRoute'),
  observationBudgetOverride: f('decision', true, V8, 'observation budget for the decision; restageThrough sets 4 at the C3 handoff'),
  observationBudgetRemaining: f('decision', true, V8, 'fresh reads left in the decision; the capsule fallback and C3 handoff re-seed it, handleToolBatch spends it'),
  observationRelevanceOverride: f('decision', true, V8, 'Jev-selected observation families for the decision (restored like the budgets)'),
  planningHorizonOverride: f('decision', true, V8, 'planning horizon for the decision (restored like the budgets)'),
  goalDefinitionRetries: f('decision', true, V8, 'goal-definition correction retries (enforceGoalDefinition, goalDefinitionError)'),
  lastGoalDefinitionError: f('decision', true, V8, 'repeat detector of the goal-definition correction'),
  goalDefinitionBlock: f('decision', true, V8, 'one-shot block text consumed by blockedWithoutMutation'),
  outputBudgetRecoveryUsed: f('decision', true, V8, 'compact output-budget retry used: request, continueFromModMessage, cancel, step-close roll'),
  outputBudgetRecoveryGuard: f('decision', false, V8, 'evidence guard of the output-budget retry'),
  actionOmissionRepairActive: f('decision', true, V8, 'act-or-block repair in force: request, continueFromModMessage, cancel, clearActionOmissionRecovery'),
  actionOmissionObservationUsed: f('decision', true, V8, 'the repair\'s one observation spent: same reset sites'),
  actionOmissionForceNoTools: f('decision', true, V8, 'closes tools for the repair decision: same reset sites'),
  pendingFiniteNoOperationPlan: f('decision', true, V8, 'plan held while the no-operation pressure runs: same reset sites'),
  freshObservationSinceContinuation: f('decision', true, V8, 'a fresh read happened since the continuation: same reset sites'),
  genericRecoveryDecisionActive: f('decision', true, V8, 'generic recovery decision flag: request, continueFromModMessage, cancel, recoverPlanRoute'),
  staleExactPreflightRetries: f('decision', true, V8, 'preflight retry budget reset per continuation (continueFromModMessage) and per request'),
  modelCorrectablePreflightRetries: f('decision', true, V8, 'preflight retry budget reset per continuation and by resetRefusalRecoveryBudgets'),
  worldCorrectionRetries: f('decision', true, V8, 'preflight retry budget reset per continuation and by resetRefusalRecoveryBudgets'),
  researchPreflightRetries: f('decision', true, V8, 'preflight retry budget reset per continuation and per request'),
  postBatchFacts: f('decision', true, V8, 'held post-batch facts shown as a tail block (not in messages); valid for one step key and world mutation; cleared by reset()/deliverPostBatchFacts only'),
  duplicateToolRounds: f('decision', true, ST, 'duplicate-observation rounds: reset in staging reset/completed, v8 continueFromModMessage/restageContext/returnControlToPlanner/epoch refresh'),
  observationRecoveryRounds: f('decision', true, ST, 'observation-recovery rounds: same reset sites as duplicateToolRounds'),
  observationOnlyRounds: f('decision', true, ST, 'observation-only rounds: same reset sites as duplicateToolRounds'),
  finiteNoOperationPressureUsed: f('decision', true, ST, 'no-operation pressure spent: staging reset/completed, v8 continueFromModMessage, lifecycle resets (restage, planner.return, epoch.rebuild)'),
  toolValidationRetries: f('decision', true, ST, 'tool validation retries: staging reset/completed/runTurn, v8 continueFromModMessage, lifecycle resets (restage, planner.return, epoch.rebuild)'),
  planCategoryRetries: f('decision', true, ST, 'plan category retries: staging reset/completed/runTurn, v8 continueFromModMessage, lifecycle resets (restage, planner.return, epoch.rebuild)'),
  observationDecisionPressure: f('decision', true, ST, 'observation phase closing pressure, cleared by resetObservationDecisionState'),
  observationDecisionPressureRemaining: f('decision', true, ST, 'rounds left before the phase closes, cleared by resetObservationDecisionState'),
  observationDecisionForced: f('decision', true, ST, 'phase closed (tools off), cleared by resetObservationDecisionState'),
  observationPhaseClosedBy: f('decision', true, V8, 'why the phase closed (post-batch coverage), cleared by v8 resetObservationDecisionState and reopenReadsForReview'),
  closedRoundObservationUsed: f('decision', true, V8, 'the closed round\'s one targeted read: resetObservationDecisionState'),
  freshContextRecoveryInProgress: f('decision', false, V8, 'fresh-context recovery guard: clearActionOmissionRecovery, tryFreshContextActionRecovery'),
  recoveryCommitDepth: f('decision', false, V8, 'recoverPlan nesting counter'),
  stepContractAborts: f('decision', false, V8, 'abort controllers of in-flight step contract calls (abortStepContractCalls in reset())'),
  stepContractsInFlight: f('decision', false, V8, 'in-flight step contract promises, deleted when they settle'),
  receiptPrefixSettlement: f('decision', true, V8, 'prefix settlement guidance for the next failure message; taken once in failed()'),

  // --- step ------------------------------------------------------------------------------------------------------
  providerBudgetGeneration: f('step', false, V8, 'output budget generation, rolled at each verified step close (rollProviderBudgetAtStepClose)'),
  providerBudgetGenerationOutputUnits: f('step', false, V8, 'output units spent in the generation, zeroed at the roll'),
  handoffFuelSources: f('step', true, V8, 'fuel source reads keyed plan|step|actor|epoch|resource, bounded LRU, never cleared'),
  reviewReadReopenedSteps: f('step', true, V8, 'once-per-step review reopen guard keyed by step key, bounded Set'),
  reviewContinuation: f('step', false, V8, 'one planner round per step marker: handlePlannerReview sets it, commitPlan consumes it'),
  stepFactWorkingSet: f('step', true, V8, 'recipes read per step key (post-batch-facts.mjs), bounded to 8 steps, never cleared'),
  stepReadLedger: f('step', false, V8, 'reads delivered to the executor per step identity (actor/epoch, session, plan id and version, step id) and the conversation that got them, bounded; survives a conversation swap so the first re-read of a dropped result costs no observation budget (StepReadLedger, handleToolBatch); never cleared'),
  localFluidSearchObservation: f('step', true, V8, 'water search fact scoped by localSearchScope; invalidated by noteWorldMutation (ambiguous: decision-length)'),
  localPumpSearchObservation: f('step', true, V8, 'pump search fact scoped by localSearchScope; invalidated by noteWorldMutation (ambiguous: decision-length)'),

  // --- goal ------------------------------------------------------------------------------------------------------
  loadedSkillContext: f('goal', true, V8, 'loaded skill details re-injected by providerMessages each round; cleared by clearLoadedSkillContext on new goal, completion, terminate'),
  goalReading: f('goal', true, V8, 'Jev blind goal reading: nulled on new_goal in requestInteractionPlannerShape'),
  goalRequirements: f('goal', true, GOALREQ, 'requirements block re-rendered as a tail block each round (providerMessages strips the stored copy); reset on new_goal and completion'),
  requirementsGroundingAsked: f('goal', true, GOALREQ, 'first-plan grounding round asked once per goal; ensureGoalRequirements resets it on new_goal'),
  skillOffers: f('goal', true, SKILLS, 'skill offer block re-rendered each round (stored copy stripped by providerMessages); cleared at completion'),
  handoffFluidHints: f('goal', true, V8, 'native fluid-tile anchors: resetHandoffFluidHints on new_goal and completion'),
  planTiming: f('goal', true, V8, 'PlanTiming estimates pushed into continuations (pushTimeEstimateContext); keyed per goal/step inside, never reassigned (ambiguous)'),
  jevObservationLog: f('goal', false, V8, 'observation log given to Jev, reset on new_goal in requestInteractionPlannerShape'),

  // --- turn ------------------------------------------------------------------------------------------------------
  turnConversation: f('turn', false, V8, 'attribution of the conversation the running turn last read; null between turns, cleared at restage and planner resume'),
  turnDepth: f('turn', false, V8, 'nested runTurn depth'),
  providerAbort: f('turn', false, ST, 'abort handle of the in-flight provider call (reset() aborts it)'),
  providerCallsInFlight: f('turn', false, V8, 'provider rounds in flight; restageGuardRefusal refuses a restage while it is above zero'),
  providerCallsByGeneration: f('turn', false, V8, 'the same count per loop generation'),
  conditionPollPromise: f('turn', false, V8, 'running condition-wait poll'),
  parseStatefulReached: f('turn', false, V8, 'set once the parse passes its shape half, for the current parse attempt'),
  compactionDeferred: f('turn', true, V8, 'true while a tool batch is being handled so compactWorkingContext skips (handleToolBatch finally)'),

  // --- telemetry -------------------------------------------------------------------------------------------------
  traceRequest: f('telemetry', false, V8, 'request trace record with id and usage; nulled at request ends and cancel()'),
  currentTraceRequest: f('telemetry', false, V8, 'backing field of the traceRequest accessor'),
  traceRequestSequence: f('telemetry', false, V8, 'request id counter'),
  decisionRequestSequence: f('telemetry', false, V8, 'decision id counter'),
  decisionTraceSequence: f('telemetry', false, V8, 'decision trace row counter'),
  jevHealth: f('telemetry', false, V8, 'Jev health tallies, summarised into traces (takeJevHealthSummary)'),
  pendingGoalReadingTrace: f('telemetry', false, V8, 'trace payload of the goal reading challenge'),
  usageLedger: f('telemetry', false, V8, 'usage per goal and budget warning, trace-only'),
  chatAcknowledger: f('telemetry', false, V8, 'player acknowledgement chat line, not a provider message'),
  danglingReferencesTraced: f('telemetry', false, V8, 'A1 trace dedupe keyed by conversationSeq+kind+key, bounded at 256'),
  pendingSupersededHandoffTrace: f('telemetry', false, V8, 'trace row staged by providerMessages, flushed in callProvider'),
  lastSupersededHandoffTrace: f('telemetry', false, V8, 'last stale handoff trace row'),
  lastProviderRound: f('telemetry', false, V8, 'last provider round summary'),
  lastTerminalRequestId: f('telemetry', false, V8, 'request id of the last terminal trace row'),
  workingCeilingTracedFor: f('telemetry', false, V8, 'dedupe key of the compaction.ceiling trace row'),
  requirementsSequence: f('telemetry', false, GOALREQ, 'sequence number of requirements blocks, only stamped on the block'),
  skillSearchSequence: f('telemetry', false, SKILLS, 'staleness fence counter of skill searches'),
  skillOfferSequence: f('telemetry', false, SKILLS, 'offer sequence number'),
  lastFollowedSkillKey: f('telemetry', false, SKILLS, 'skill.followed trace dedupe key, reset on each new offer'),
})

// Sources the registry is checked against. Paths are relative to this module.
export const LOOP_STATE_SOURCES = Object.freeze({
  [V8]: 'npc-agent-loop.mjs',
  [ST]: '../staging/npc-agent-loop.mjs',
  [ADAPTER]: 'supervisor-adapter.mjs',
  [GOALREQ]: 'goal-requirements.mjs',
  [SKILLS]: 'skill-offers.mjs',
  [SUPERVISOR]: 'supervisor.mjs',
})

// Owners scanned for `receiver.field` assignments over the whole file instead
// of inside `class NpcAgentLoop`.
const EXTERNAL_RECEIVERS = Object.freeze({
  [ADAPTER]: ['loop', 'this'], // prototype wrappers assign on `this`, helpers on `loop`
  [SUPERVISOR]: ['agent'],
})
const CLASS_OWNERS = new Set([V8, ST])

// Where the conversation in `messages` is replaced (or rewritten in place).
// `receiver` is how the body reaches the loop; `fn` marks a top-level function;
// `noHelpers` skips helper resolution (runGuardedTurn only calls reset() on its failure path);
// `delegates` names swap sites this one reaches through a restage wrapper (more than one call deep).
// B1: the fields the v8 loop keeps in AgentContext.conversationState (accessors
// in npc-agent-loop.mjs). Every conversation swap starts them empty, and
// CONVERSATION_SLOT_CARRY there decides what an in-place rebuild keeps.
export const CONVERSATION_STATE_SLOTS = Object.freeze(['toolCache', 'prototypeRefsThisRequest', 'unchangedFactReads', 'taskStatusDiffBaseline'])

export const CONVERSATION_SWAP_SITES = Object.freeze([
  { site: 'reset', owner: V8, kind: 'reset', note: 'new lineage via agentContext.beginLineage, then super.reset()' },
  { site: 'reset', owner: ST, kind: 'reset', note: 'messages/baseMessages emptied; also run on cancel and actor change' },
  { site: 'request', owner: ST, kind: 'request_start', note: 'builds a fresh baseMessages/messages after reset()' },
  { site: 'restageContext', owner: V8, kind: 'restage', note: 'agentContext.commitRestage swaps in the packet conversation' },
  { site: 'restageContext', owner: V8, kind: 'fold_resume', note: 'foldKept: agentContext.resumeExecutor brings back the executor kept through a planner review round (same conversation, same slots; the planner is parked again)' },
  { site: 'replaceExecutorStepBlock', owner: V8, kind: 'in_place_rewrite', note: 'replaces the volatile step block in baseMessages and messages (the receipt refresh, and the step block of a folded review handback)' },
  { site: 'returnControlToPlanner', owner: V8, kind: 'planner_resume', note: 'agentContext.resumePlanner drops the executor conversation (or keeps it through a review round) and restores the parked planner' },
  { site: 'refreshPlanningReasoningEpoch', owner: V8, kind: 'epoch_rebuild', note: 'planner rebuild from durable memory when the reasoning epoch moved, through replaceConversation (B2)' },
  { site: 'prepareContinuationContext', owner: V8, kind: 'continuation', note: 'epoch rebuild, else super + planContext; the adapter wrapper then appends baseline blocks' },
  { site: 'prepareContinuationContext', owner: ST, kind: 'continuation', note: 'messages = baseMessages + prototype context + latest plan' },
  { site: 'completed', owner: ST, kind: 'continuation', note: 'base completed() builds the continuation conversation (v8 uses continueFromModMessage)' },
  { site: 'continueFromModMessage', owner: V8, kind: 'continuation', note: 'v8 slice continuation: prepareContinuationContext plus its own counter resets' },
  { site: 'applyStartRestage', owner: V8, kind: 'start_restage', delegates: ['restageContext'], note: 'C5 restage on Resume via restageBetweenTurns; budget.handoff_restage_fallback keeps the built conversation when refused' },
  { site: 'recoverPlanRoute', owner: V8, kind: 'capsule_fallback', delegates: ['restageContext'], note: 'provider-budget handoff: restageInTurn, else replaceConversation with role prefix + capsule (budget.handoff_restage_fallback, B2)' },
  { site: 'compactWorkingContext', owner: V8, kind: 'compaction', note: 'folds old tool exchanges into [OBSERVATIONS COMPACTED]' },
  { site: 'compactWorkingContext', owner: ST, kind: 'compaction', note: 'base compaction of old tool exchanges' },
  { site: 'executorFactsRefreshText', owner: V8, kind: 'in_place_rewrite', note: 'replaces the volatile step block in baseMessages and messages, keeps conversation identity' },
  { site: 'runGuardedTurn', owner: V8, kind: 'prefix_rewrite', noHelpers: true, note: 'rewrites the system prefix of a fresh chat lineage with the role prefix' },
  { site: 'recoverInterruptedAgentPlan', owner: SUPERVISOR, receiver: 'agent', fn: true, kind: 'recovery_rebuild', delegates: ['restageContext'], note: 'supervisor recovery replaces the conversation through agent.replaceConversation (B2), then restageRecoveryConversation' },
])

// --- scanning ------------------------------------------------------------------------------------------------

// Same-length copy of `text` with comments and string/template text blanked
// (newlines kept, so line numbers survive). `${...}` expressions stay as code.
export function stripCommentsAndStrings(text) {
  const out = text.split('')
  const n = text.length
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
  // Brace depth at which each open `${` closes, so its expression stays code.
  const templateStack = []
  let depth = 0
  let i = 0
  let lastSignificant = ''
  const scanTemplateText = (start) => {
    let k = start
    while (k < n) {
      const c = text[k]
      if (c === '\\') { k += 2; continue }
      if (c === '`') { blank(start, k); return k + 1 }
      if (c === '$' && text[k + 1] === '{') {
        blank(start, k)
        templateStack.push(depth)
        depth++
        return k + 2
      }
      k++
    }
    blank(start, n)
    return n
  }
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      let j = i
      while (j < n && text[j] !== '\n') j++
      blank(i, j)
      i = j
      continue
    }
    if (c === '/' && next === '*') {
      const j = text.indexOf('*/', i + 2)
      const end = j === -1 ? n : j + 2
      blank(i, end)
      i = end
      continue
    }
    if (c === '\'' || c === '"') {
      let j = i + 1
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      blank(i + 1, Math.min(j, n))
      i = j + 1
      lastSignificant = c
      continue
    }
    if (c === '`') {
      i = scanTemplateText(i + 1)
      lastSignificant = '`'
      continue
    }
    if (c === '/' && !/[\w$)\]'"`]/.test(lastSignificant)) {
      // A slash after a token that cannot end an expression starts a regex literal.
      let j = i + 1
      let inClass = false
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        else if (text[j] === '/' && !inClass) break
        j++
      }
      blank(i + 1, Math.min(j, n))
      i = j + 1
      lastSignificant = '/'
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === depth) {
        templateStack.pop()
        i = scanTemplateText(i + 1)
        lastSignificant = '`'
        continue
      }
    }
    if (!/\s/.test(c)) lastSignificant = c
    i++
  }
  return out.join('')
}

// Index of the bracket that closes the one at openIndex (text must be stripped).
export function matchBracket(text, openIndex, open = '{', close = '}') {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

export function findClassBody(stripped, className = 'NpcAgentLoop') {
  const match = new RegExp(`\\bclass\\s+${className}\\b`).exec(stripped)
  if (!match) return null
  const open = stripped.indexOf('{', match.index)
  if (open === -1) return null
  const close = matchBracket(stripped, open)
  if (close === -1) return null
  return { start: open + 1, end: close, text: stripped.slice(open + 1, close) }
}

const ASSIGN_OPERATORS = '(\\?\\?=|\\|\\|=|&&=|\\+=|-=|=(?![=>])|\\+\\+|--)'
const assignRe = receiver => new RegExp(`\\b${receiver}\\.([A-Za-z_$][\\w$]*)[ \\t]*${ASSIGN_OPERATORS}`, 'g')
// `++this.x` / `--this.x`, but not the tail of `a++` followed by a newline and `this.`.
const prefixRe = receiver => new RegExp(`(?<![\\w$)\\]]\\s*)(?:\\+\\+|--)[ \\t]*${receiver}\\.([A-Za-z_$][\\w$]*)\\b`, 'g')

function collectAssignments(text, receivers, lineOf) {
  const result = new Map()
  for (const receiver of receivers) {
    for (const re of [assignRe(receiver), prefixRe(receiver)]) {
      for (const m of text.matchAll(re)) {
        if (!result.has(m[1])) result.set(m[1], [])
        result.get(m[1]).push(lineOf(m.index))
      }
    }
  }
  return result
}

// field name -> 1-based line numbers of its assignments. Class owners are
// scanned inside `class NpcAgentLoop` only; other owners over the whole file.
export function scanAssignments(source, owner = V8) {
  const stripped = stripCommentsAndStrings(source)
  if (CLASS_OWNERS.has(owner)) {
    const body = findClassBody(stripped)
    if (!body) return new Map()
    const lineOf = index => stripped.slice(0, body.start + index).split('\n').length
    return collectAssignments(body.text, ['this'], lineOf)
  }
  const lineOf = index => stripped.slice(0, index).split('\n').length
  return collectAssignments(stripped, EXTERNAL_RECEIVERS[owner] ?? ['loop'], lineOf)
}

// sources: owner -> file text. Returns owner -> Set of assigned field names.
export function scanLoopFields(sources) {
  const result = {}
  for (const [owner, text] of Object.entries(sources)) result[owner] = new Set(scanAssignments(text, owner).keys())
  return result
}

export function readLoopSources(baseDir = path.dirname(fileURLToPath(import.meta.url))) {
  const sources = {}
  for (const [owner, relative] of Object.entries(LOOP_STATE_SOURCES)) sources[owner] = fs.readFileSync(path.resolve(baseDir, relative), 'utf8')
  return sources
}

// --- conversation reset matrix -----------------------------------------------------------------------------------

// Stripped text of a method (class owners) or top-level function body, or null.
export function findMethodBody(strippedSource, name, { owner = V8, fn = false } = {}) {
  let scope = strippedSource
  if (!fn && CLASS_OWNERS.has(owner)) {
    const body = findClassBody(strippedSource)
    if (!body) return null
    scope = body.text
  }
  const head = fn
    ? new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm')
    : new RegExp(`^ {2}(?:async\\s+)?${name}\\s*\\(`, 'm')
  const match = head.exec(scope)
  if (!match) return null
  const parenOpen = match.index + match[0].length - 1
  const parenClose = matchBracket(scope, parenOpen, '(', ')')
  if (parenClose === -1) return null
  const braceOpen = scope.indexOf('{', parenClose)
  const braceClose = braceOpen === -1 ? -1 : matchBracket(scope, braceOpen)
  if (braceClose === -1) return null
  return scope.slice(braceOpen + 1, braceClose)
}

// Fields a body resets directly: `=` assignment, .clear(), .length = 0, .splice(. A `??=`
// only initialises, so it is not a reset. The result is the union over every branch of the
// body, so it is optimistic for a site whose reset sits in one branch.
function directResets(body, receivers, names) {
  const found = new Set()
  for (const name of names) {
    for (const receiver of receivers) {
      const field = `\\b${receiver}\\.${name.replace(/\$/g, '\\$')}`
      if (new RegExp(`${field}[ \\t]*=(?![=>])`).test(body)
        || new RegExp(`${field}\\.clear\\(\\)`).test(body)
        || new RegExp(`${field}\\.length[ \\t]*=[ \\t]*0\\b`).test(body)
        || new RegExp(`${field}\\.splice\\(`).test(body)) {
        found.add(name)
        break
      }
    }
  }
  // The AgentContext owns the conversation: its swap calls replace both arrays
  // and, since B1/B2, the conversation-state slots with them.
  if (/\bagentContext\.(?:commitRestage|restage|resumePlanner|beginLineage|replaceConversation)\(|\b(?:this|agent)\.replaceConversation\(/.test(body)) {
    found.add('messages')
    found.add('baseMessages')
    for (const slot of CONVERSATION_STATE_SLOTS) found.add(slot)
  }
  return found
}

// Rows: { site, owner, kind, resets, delegated, missing, missing_model_visible, missing_if_restage_refused }
// over the conversation- and decision-scoped fields of the registry. A site in
// the staging class is judged on staging-owned fields (plus the messages), since
// the v8 subclass adds its own resets around it.
export function conversationResetMatrix(sources, registry = LOOP_STATE_FIELDS, sites = CONVERSATION_SWAP_SITES) {
  const stripped = {}
  for (const [owner, text] of Object.entries(sources)) stripped[owner] = stripCommentsAndStrings(text)
  const allTracked = Object.keys(registry).filter(name => registry[name].scope === 'conversation' || registry[name].scope === 'decision')
  const bodyOf = (owner, name, fn) => (stripped[owner] ? findMethodBody(stripped[owner], name, { owner, fn }) : null)
  const directRows = new Map()
  const rowFor = (site) => {
    const tracked = site.owner === ST
      ? allTracked.filter(name => registry[name].owner === ST || name === 'messages' || name === 'baseMessages')
      : allTracked
    const receivers = [site.receiver ?? 'this']
    const body = bodyOf(site.owner, site.site, site.fn === true)
    if (body === null) return { tracked, resets: new Set(), error: 'method_not_found' }
    const resets = directResets(body, receivers, tracked)
    // C2: a lifecycle site's applyLifecycleResets() sets the counters its LIFECYCLE_TABLE entry lists (lifecycle.test.mjs
    // proves the call names that site's own event).
    const lifecycle = LIFECYCLE_SITES.find(entry => entry.owner === site.owner && entry.site === site.site)
    if (lifecycle && /\bapplyLifecycleResets\s*\(/.test(body)) {
      for (const name of Object.keys(lifecycleResets(lifecycle.event))) if (tracked.includes(name)) resets.add(name)
    }
    // One level deep: helpers called as this.x() / super.x(). A subclass helper may live in either class.
    if (site.fn !== true && site.noHelpers !== true) {
      const helperRe = /\b(?:this|super)\.([A-Za-z_$][\w$]*)\s*\(/g
      const helpers = new Set()
      for (const m of body.matchAll(helperRe)) helpers.add(m[1])
      const owners = site.owner === V8 ? [V8, ST] : [site.owner]
      for (const helper of helpers) {
        for (const owner of owners) {
          const helperBody = bodyOf(owner, helper, false)
          if (helperBody === null) continue
          for (const name of directResets(helperBody, receivers, tracked)) resets.add(name)
        }
      }
    }
    return { tracked, resets }
  }
  for (const site of sites) directRows.set(`${site.owner}#${site.site}`, rowFor(site))
  const rows = []
  for (const site of sites) {
    const { tracked, resets, error } = directRows.get(`${site.owner}#${site.site}`)
    const delegated = new Set()
    for (const delegate of site.delegates ?? []) {
      for (const name of directRows.get(`${V8}#${delegate}`)?.resets ?? []) if (tracked.includes(name) && !resets.has(name)) delegated.add(name)
    }
    const missing = tracked.filter(name => !resets.has(name) && !delegated.has(name))
    const row = {
      site: site.site,
      owner: site.owner,
      kind: site.kind,
      resets: tracked.filter(name => resets.has(name)),
      delegated: tracked.filter(name => delegated.has(name)),
      missing,
      missing_model_visible: missing.filter(name => registry[name].model_visible),
    }
    // The fallback taken when the restage is refused only has the direct resets.
    if (delegated.size > 0) row.missing_if_restage_refused = tracked.filter(name => !resets.has(name) && registry[name].model_visible)
    if (error) row.error = error
    rows.push(row)
  }
  return rows
}

export function countsByScope(registry = LOOP_STATE_FIELDS) {
  const counts = Object.fromEntries(STATE_SCOPES.map(scope => [scope, { total: 0, model_visible: 0 }]))
  for (const entry of Object.values(registry)) {
    counts[entry.scope].total++
    if (entry.model_visible) counts[entry.scope].model_visible++
  }
  return counts
}

export function renderReport(rows, counts) {
  const lines = ['| Swap site | Owner | Kind | Resets (conversation/decision scope) | Via restage | Missing model-visible | Missing if restage refused |', '| --- | --- | --- | --- | --- | --- | --- |']
  for (const row of rows) {
    const cell = list => (list && list.length > 0 ? list.join(', ') : '(none)')
    lines.push(`| ${row.site} | ${row.owner} | ${row.kind} | ${row.error ?? cell(row.resets)} | ${cell(row.delegated)} | ${cell(row.missing_model_visible)} | ${row.missing_if_restage_refused ? cell(row.missing_if_restage_refused) : 'n/a'} |`)
  }
  lines.push('', '| Scope | Fields | Model-visible |', '| --- | --- | --- |')
  let total = 0
  let visible = 0
  for (const scope of STATE_SCOPES) {
    lines.push(`| ${scope} | ${counts[scope].total} | ${counts[scope].model_visible} |`)
    total += counts[scope].total
    visible += counts[scope].model_visible
  }
  lines.push(`| total | ${total} | ${visible} |`)
  return lines.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  if (!args.includes('--report')) {
    console.error('usage: node state-scopes.mjs --report [--json]')
    process.exitCode = 2
    return
  }
  const rows = conversationResetMatrix(readLoopSources())
  const counts = countsByScope()
  console.log(args.includes('--json') ? JSON.stringify({ rows, counts }, null, 2) : renderReport(rows, counts))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
