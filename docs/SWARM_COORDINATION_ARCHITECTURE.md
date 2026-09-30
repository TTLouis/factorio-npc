# SGLuna Factorio — Swarm Coordination Architecture

**Status:** Planned architecture. Not implemented. No multi-agent engine validation is claimed.

This document records the working design for SGLuna's future swarm coordination layer. It is a companion to `NPC_AGENT_HARNESS_PLAN.md` and does not replace the single-NPC reliability gates there.

The first swarm version should focus on shared operational state, adaptive work claiming, and mission tracking. More sophisticated inference/API routing is intentionally deferred; the coordination model must work even if all agents initially use the existing simple harness/provider setup.

---

# 1. Core principle

Agents do not own permanent jobs. Agents temporarily own commitments.

A standalone SGLuna character remains a general-purpose engineer. Mining, building, delivering, defending, surveying, and planning describe current activity, not permanent identity.

The swarm should adapt through world state and useful work:

```text
mission state changes
        ↓
new work becomes valuable
        ↓
agents evaluate eligible work
        ↓
temporary claims move toward the new bottleneck
        ↓
results update the mission state
```

Do not model the swarm as fixed `miner`, `builder`, `logistics`, or `combat` actors. Roles may be useful human-facing labels for current activity, but the scheduler must trust capabilities and current state rather than a permanent job field.

Useful work selection should eventually consider:

- capability;
- current location;
- inventory/equipment;
- current commitments;
- project/mission priority;
- dependency-unblocking value;
- travel cost;
- switching cost;
- local knowledge/evidence;
- risk and actor health;
- relevant reservations.

The backend should make routine eligibility and scoring deterministic where practical. The model should make meaningful choices among bounded candidates rather than rediscovering the entire factory every turn.

---

# 2. Coordination layers

Keep four levels distinct:

```text
Mission
    desired world outcome and acceptance criteria
        ↓
Objective / Project
    dependency and bounded implementation scope
        ↓
Blackboard work
    claimable useful work and requests
        ↓
Actor operation
    bounded Factorio action
```

The ownership boundary is:

| Layer | Responsibility |
|---|---|
| Mission tracker | Why the swarm is doing something; desired outcomes, dependencies, priority, blockers, acceptance. |
| Project/objective layer | Bounded implementation scope, designs, reservations, work generation, verification. |
| Blackboard / Message Board | What useful work, needs, observations, warnings, claims, and results exist right now. |
| Agent harness | Build bounded context, choose/release work, maintain the agent's current plan/commitment, validate actions. |
| Autorio / actor runtime | Physical character state, deterministic task execution, inventory, movement, completion, cancellation. |

The Mission Tracker must not issue tick-level actor commands. Autorio must not need to understand strategic goals such as "automate blue science."

---

# 3. Blackboard: backend for the in-game Message Board

The player-facing feature can be called the **Message Board**, but its backend should be a structured **Blackboard** rather than primarily free-form agent chat.

The blackboard contains current canonical records plus an event history for debugging/replay.

Initial record families:

- **Work Items** — something useful that one agent can commit to;
- **Requests** — a need that another agent/project may satisfy;
- **Observations** — shared evidence about the world;
- **Warnings** — urgent or abnormal conditions;
- **Claims / Leases** — temporary responsibility for work;
- **Results** — evidence-backed outcomes;
- **Reservations** — protected items/areas/entities needed by active work (limited V1 support).

Natural-language text is presentation, not authority. For example, the GUI may render:

```text
SGLuna-3 needs 40 transport belts at Green Circuit Block #2.
```

but the authoritative record should identify the requested item/count, destination, requester, project, priority, status, revision, and creation tick.

## 3.1 Canonical records plus events

Agents should query current state directly. They should not replay thousands of historical messages to discover whether a task is still open.

Conceptual event shape:

```ts
interface BlackboardEvent {
  id: EventId
  recordId: BlackboardId
  event:
    | 'created'
    | 'updated'
    | 'claimed'
    | 'released'
    | 'started'
    | 'blocked'
    | 'completed'
    | 'cancelled'
    | 'expired'
  agentId?: AgentId
  tick: number
  revision: number
  details?: unknown
}
```

Keep the current record compact while retaining bounded/auditable history for tests and diagnostics.

---

# 4. Work Items

A Work Item is the main unit of temporary agent commitment. It should be small enough that one agent can meaningfully own progress toward it, but larger than an individual Autorio operation.

Conceptual shape:

```ts
interface WorkItem {
  id: WorkId
  kind: 'work'

  missionId?: MissionId
  objectiveId?: ObjectiveId
  projectId?: ProjectId

  createdBy: AgentId | 'mission-tracker' | 'system'

  goal: WorkGoal
  requirements: WorkRequirements
  location?: WorldLocation

  priority: number

  status:
    | 'pending_dependency'
    | 'open'
    | 'claimed'
    | 'active'
    | 'blocked'
    | 'completed'
    | 'cancelled'

  dependencies: WorkId[]
  blockingRequests: RequestId[]

  claimId?: ClaimId
  evidence: EvidenceRef[]

  createdTick: number
  updatedTick: number
  revision: number
}
```

Common typed `WorkGoal` variants should be added gradually, for example:

- acquire/deliver items;
- construct a registered design;
- survey an area/resource;
- increase a production/delivery capacity;
- defend/repair an area;
- verify an acceptance condition.

Keep a bounded custom/description variant for work that has not yet earned a dedicated schema.

## 4.1 Requirements describe capability, not role

Do not use `requiredRole: 'miner'`.

Use requirements such as:

```text
capabilities:
  move
  mine
```

Candidate capabilities can include `move`, `mine`, `craft`, `build`, `transfer`, `combat`, `repair`, `inspect`, `survey`, and later vehicle-specific capabilities.

Capability answers whether the actor can perform the class of work. Candidate scoring decides whether that work is a sensible commitment now.

## 4.2 Dependency eligibility

Work with unsatisfied dependencies is `pending_dependency`, not claimable. When dependencies become satisfied, deterministic board logic promotes it to `open` without an LLM call.

A blocked work item should not simply reopen while its blocker remains true. Otherwise multiple agents can repeatedly fail on the same missing prerequisite.

---

# 5. Requests

A Request describes a need. A Work Item describes something an actor can do. Keep them distinct.

Examples:

- `material_request`: bring 40 belts;
- `observation_request`: survey an oil field;
- `construction_request`: connect power to an area;
- `assistance_request`: another agent is required;
- `decision_request`: strategic choice is needed;
- `defense_request`: area is under threat;
- `transport_request`: move items between locations;
- `capacity_request`: provide an additional material rate.

A request may generate work automatically, or planning may choose among multiple ways to satisfy it.

For example, `need +15 iron plates/s` must not imply `build more furnaces`. Valid remedies might include increasing smelting, rerouting spare supply, reducing another allocation, using a temporary reserve when explicitly acceptable, or changing the requested production target.

Requests should reference what they block. When a request is satisfied, deterministic logic can re-evaluate and reopen dependent work.

---

# 6. Observations, warnings, and results

## 6.1 Observations are shared evidence

Agents should not depend on long chat histories to remember discovered world facts.

An Observation should record:

- observer;
- simulation tick/window;
- subject/entity/area/resource/connection;
- structured data;
- evidence class (`engine_read`, `measured`, `estimated`);
- freshness/expiry/dependency revision where relevant;
- superseded observation when replacing older knowledge.

Stale evidence must be distinguishable from current evidence.

## 6.2 Warnings are actionable abnormalities

Warnings can include:

- attack/defense emergency;
- actor stuck/no progress;
- supply shortage;
- project area conflict;
- invalid/stale design assumptions;
- actor death/recovery;
- repeated task failure.

Warnings may raise work priority or create new work, but they do not bypass project authority or execution gates.

## 6.3 Results require evidence

An agent/model saying "done" is not enough to complete work.

A result should record:

```ts
interface WorkResult {
  id: ResultId
  workId: WorkId
  agentId: AgentId
  status: 'success' | 'partial' | 'failure'
  evidence: EvidenceRef[]
  summary: string
  tick: number
}
```

Completion should use relevant observed state, measurements, or operation receipts. This preserves the existing verification-first rule: operation completion and goal completion are different things.

---

# 7. Claims: temporary responsibility, not ownership

A claim means:

> This agent currently intends to make progress on this work.

It does not mean the agent permanently owns the job.

Claims are leases tied to simulation time.

```ts
interface WorkClaim {
  id: ClaimId
  workId: WorkId
  agentId: AgentId
  actorId: ActorId

  acquiredTick: number
  leaseUntilTick: number
  lastProgressTick: number

  workRevision: number

  state: 'claimed' | 'active' | 'releasing'

  progress?: {
    summary: string
    evidence?: EvidenceRef[]
  }
}
```

Use `game.tick`, not wall time, for authoritative lease expiry. A paused simulation should not silently expire commitments. External harness safety timers remain separate.

## 7.1 Atomic claim / revision protection

Claiming must be compare-and-swap style:

```text
claim(work_id, agent_id, expected_revision)
```

Admission requires at least:

- work revision still matches;
- status is claimable;
- dependencies are satisfied;
- no active claim exists;
- actor still has required capabilities/authority.

A successful claim increments the work revision and creates the lease. A competing stale claim fails cleanly.

This prevents two agents from both believing they won the same work.

## 7.2 Heartbeat only on useful progress

Do not renew leases merely because a model is alive.

Useful progress may include:

- actor movement toward a required destination;
- operation state progression;
- relevant inventory delta;
- subtask completion;
- new evidence/result posted;
- dependency materially advanced.

Routine long-running operations can renew their claim through deterministic runtime progress without an LLM call.

No meaningful progress for a bounded interval should create a warning and eventually allow claim expiry/recovery.

## 7.3 Release and blocking

Agents must be able to release work without being considered a failure.

Structured release reasons can include:

- blocker discovered;
- capability lost;
- dependency invalidated;
- target missing;
- supply shortage;
- path unreachable;
- higher-priority preemption;
- mission/project cancelled;
- actor recovery/death;
- bounded no-progress timeout.

If a durable blocker exists, release should normally transition the work to `blocked` and create/reference a Request rather than immediately returning it to `open`.

---

# 8. Adaptive work selection

Agents should choose among eligible work, not receive permanent occupations.

The harness should reduce the board to a small candidate set before involving a model:

```text
all open work
    ↓
capability filter
    ↓
dependency / authority filter
    ↓
reachable / relevant-region filter
    ↓
deterministic utility scoring
    ↓
top bounded candidates
    ↓
agent/model chooses or harness auto-selects
```

A candidate score can expose factors such as:

```ts
interface WorkCandidateScore {
  workId: WorkId
  finalScore: number
  factors: {
    priority: number
    locality: number
    inventoryFit: number
    continuity: number
    dependencyValue: number
    switchingPenalty: number
    riskPenalty: number
  }
}
```

The exact formula is tunable. The important requirement is that it is deterministic, inspectable, and not hidden inside prompt prose.

## 8.1 Avoid thrashing

Adaptability must not cause constant task switching.

Current work receives a continuity/commitment bonus. Voluntary switching should require the candidate to exceed the current commitment by a configurable threshold.

Exceptions can include:

- emergency priority;
- current work becomes impossible;
- mission/project cancellation;
- dependency invalidation;
- actor survival threat;
- explicit authorized preemption.

This creates temporary specialization naturally. An actor already near copper, carrying mining/building supplies and holding fresh local observations will often continue copper-related work without ever being assigned a permanent `miner` role.

---

# 9. Agent state

Persist commitments and focus, not occupation.

Conceptual state:

```ts
interface AgentState {
  id: AgentId
  actorId: ActorId

  state:
    | 'available'
    | 'working'
    | 'blocked'
    | 'recovering'
    | 'disabled'

  currentWorkId?: WorkId
  currentProjectId?: ProjectId
  currentMissionId?: MissionId

  focus?: {
    description: string
    sinceTick: number
  }

  activeRequestIds: RequestId[]
  lastDecisionTick?: number
}
```

The UI may derive human-readable current activity such as `Mining iron`, `Delivering belts`, or `Building circuit block`. These are statuses, not scheduler authority.

---

# 10. Mission Tracker

The Mission Tracker owns strategic desired outcomes and their evidence-backed progress.

A mission is not primarily a sequential checklist. It is a dependency graph of conditions that may be satisfied by existing factory state, new projects, or changed plans.

Conceptual shape:

```ts
interface Mission {
  id: MissionId
  title: string

  status:
    | 'proposed'
    | 'active'
    | 'blocked'
    | 'satisfied'
    | 'failed'
    | 'cancelled'

  priority: number
  goal: MissionGoal
  acceptance: AcceptanceCondition[]

  objectiveIds: ObjectiveId[]
  blockers: BlockerRef[]

  createdBy: 'human' | AgentId
  createdTick: number
  updatedTick: number
  revision: number
}
```

Example:

```text
Mission: Automate green science
Acceptance: >= 30 packs/min delivered for 5 simulated minutes
```

That mission might depend on:

```text
gear supply        SATISFIED
circuit supply     BLOCKED
science assembly   WAITING
output delivery    WAITING
```

If circuit supply becomes the limiting dependency, work naturally shifts toward that dependency. No actor needs to be designated a permanent circuit worker.

---

# 11. Objectives and Projects

## 11.1 Objectives form a dependency graph

An Objective represents a condition contributing to a mission.

```ts
interface Objective {
  id: ObjectiveId
  missionId: MissionId

  description: string

  status:
    | 'pending'
    | 'ready'
    | 'active'
    | 'blocked'
    | 'satisfied'
    | 'cancelled'

  dependencies: ObjectiveId[]
  acceptance: AcceptanceCondition[]
  evidence: EvidenceRef[]
  projectIds: ProjectId[]

  priority: number
  revision: number
}
```

An objective may already be satisfied by current factory state. Do not create construction work merely because an objective exists.

## 11.2 Projects bound world-changing implementation

A Project turns strategy into an authorized, bounded implementation scope.

```ts
interface Project {
  id: ProjectId
  missionId: MissionId
  objectiveId?: ObjectiveId

  title: string

  status:
    | 'planning'
    | 'ready'
    | 'executing'
    | 'blocked'
    | 'verifying'
    | 'complete'
    | 'cancelled'

  scope: ProjectScope
  revision: number

  workItemIds: WorkId[]
  reservationIds: ReservationId[]
  evidence: EvidenceRef[]
  blockers: BlockerRef[]
}
```

Projects are the natural integration point for the production-planning harness: design revision, allowed construction area, resource authority, production target, reservations, execution admission, and runtime acceptance belong here rather than inside one agent's memory.

Agents may post observations, requests, warnings, and proposed work. Scope-expanding world mutation must still pass project/mission authority rather than becoming executable merely because an agent suggested it.

---

# 12. Priority propagation and preemption

Mission priority should propagate downward to objectives, projects, and work, with local modifiers for urgency and dependency-unblocking value.

Example:

```text
Mission: green science              priority 70
  Objective: circuit capacity       ~70
    Project: GC block #2            ~70
      Work: deliver belts           ~65
```

A defense warning may create emergency work at priority 95. Nearby actors can preempt lower-value work if the preemption threshold is exceeded. When the emergency clears, previous work returns to the pool or is resumed if its claim remains valid.

Priority propagation should be inspectable; do not bury strategic urgency only in prompts.

---

# 13. Mission ↔ Blackboard feedback loop

Coordination is bidirectional:

```text
Mission Tracker
      ↓
creates/updates objectives, projects, work
      ↓
Blackboard
      ↓
agents claim and execute work
      ↓
results / requests / warnings / observations
      ↓
Mission Tracker re-evaluates dependencies
```

Example:

```text
Mission: produce 30 green circuits/s
    ↓
Project: construct circuit block
    ↓
Builder discovers insufficient copper delivery
    ↓
Request: +12 copper plates/s available to project
    ↓
Mission/objective graph marks copper supply blocking
    ↓
new bounded investigation/project/work becomes eligible
    ↓
other agents migrate toward copper work
```

The system reorganizes because the dependency graph and work utility changed, not because a central controller permanently labeled an actor `copper miner`.

---

# 14. Reservations

Claims reserve responsibility for work. Reservations protect world resources needed by work/project execution.

Initial useful reservation types:

- items/material quantities;
- construction areas/footprints;
- specific entities/chests.

Later versions may add production-capacity, belt/lane, train-stop, or route reservations if real contention demonstrates the need.

V1 should avoid building a generalized distributed resource allocator before tests require it.

---

# 15. Persistence and authoritative state

Operational swarm state should live with the Factorio save where practical so save/restart preserves coordination together with the world.

Candidate `storage` shape:

```ts
interface SwarmStorage {
  version: number

  agents: Record<AgentId, PersistedAgentState>

  board: {
    work: Record<WorkId, WorkItem>
    requests: Record<RequestId, RequestRecord>
    observations: Record<ObservationId, ObservationRecord>
    warnings: Record<WarningId, WarningRecord>
    claims: Record<ClaimId, WorkClaim>
    results: Record<ResultId, WorkResult>
    reservations: Record<ReservationId, Reservation>
    events: BlackboardEvent[]
  }

  missions: Record<MissionId, Mission>
  objectives: Record<ObjectiveId, Objective>
  projects: Record<ProjectId, Project>

  counters: Record<string, number>
}
```

Do not persist runtime-only Lua objects directly. Persist stable IDs/entity references needed for reacquisition.

The external harness may maintain model conversation state, summaries, provider usage, evaluation traces, and caches. Those are not substitutes for authoritative in-save claims, mission state, or world reservations.

---

# 16. Harness context for an agent turn

Do not send the full board or full factory state to every model turn.

A bounded agent decision packet should include only what is relevant:

```text
agent identity / actor snapshot
current physical state and inventory summary
current mission/project context
current commitment and progress
blocking requests
small set of relevant observations/warnings
small set of eligible work candidates + deterministic scores
current bounded agent plan
available observations/actions
recent relevant results
```

Shared evidence should be retrieved from the Blackboard rather than preserved only in an ever-growing conversation transcript.

Inference/API routing is not a V1 dependency. Initial swarm work can continue using the existing provider/harness model. Provider/model routing, heterogeneous models, and centralized inference gateways can be designed later without changing the core Mission/Blackboard/Claim contracts.

---

# 17. Proposed module boundaries

Detailed implementation may change after the single-NPC gates, but a reasonable starting split is:

```text
packages/autorio/src/swarm/
  blackboard.ts
  claims.ts
  missions.ts
```

Factorio-side responsibilities:

- authoritative persistent records;
- atomic claim/revision operations;
- simulation-tick lease expiry;
- deterministic dependency transitions;
- actor/task references;
- bounded status/query remote interfaces.

Harness-side responsibilities can later include:

```text
packages/agent/src/swarm/
  agent-runtime.ts
  work-selection.ts
  context-builder.ts
```

Harness responsibilities:

- candidate filtering/scoring inputs that require agent context;
- building bounded model context;
- asking an agent to select among admitted candidates;
- maintaining agent working plans;
- turning structured agent decisions into validated board/operation requests.

Do not move physical truth, leases, or save-critical mission/project state into model conversation history.

---

# 18. V1 state transitions

## Work

```text
pending_dependency
        ↓ dependencies satisfied
open
        ↓ atomic claim
claimed
        ↓ execution begins
active
   ├──→ blocked ── blocker satisfied ──→ open
   ├──→ completed
   └──→ cancelled
```

Claim expiry/release from `claimed` or `active` returns to `open` only when no durable blocker exists.

## Mission

```text
proposed
   ↓ admitted
active
   ├──→ blocked ── blocker changes ──→ active
   ├──→ satisfied
   ├──→ failed
   └──→ cancelled
```

Mission satisfaction is acceptance-condition driven, not model-declared.

---

# 19. V1 acceptance scenarios

The first swarm milestone should prove coordination mechanics before attempting sophisticated emergent planning.

Deterministic scenarios should include:

1. two standalone actors exist independently with separate inventory and task state;
2. two agents see the same open work and only one atomic claim succeeds;
3. the second agent selects different eligible work;
4. one active work item makes measurable progress and renews its lease;
5. a stalled claim stops renewing and eventually becomes recoverable;
6. an agent releases blocked work and creates/references a structured Request;
7. another agent claims work that satisfies the Request;
8. satisfying the Request reopens the blocked work deterministically;
9. the original or another agent resumes and completes it;
10. evidence-backed Results satisfy an Objective;
11. Objective state advances the Mission graph;
12. a high-priority warning can preempt lower-value work without creating permanent roles;
13. cancellation stops future work selection without requiring a new model response;
14. save/restart preserves missions, projects, board records, claims/lease state as specified, and actor identity/reacquisition;
15. actor death/recovery does not corrupt another actor's claims or task state.

Do not call this swarm-ready merely because multiple LLM conversations can run. The authoritative gate is independent actors plus correct coordination state under contention, blocking, recovery, and persistence.

---

# 20. Recommended V1 implementation order

After the single-NPC persistence/recovery gates are satisfied:

```text
1. Introduce stable AgentId / ActorId / WorkId / MissionId types
2. Make actor/task runtime addressable for at least two standalone actors
3. Add Blackboard storage + bounded status/query interface
4. Add Work Item and Request schemas
5. Add atomic claim/release/heartbeat/expiry with revisions
6. Add Result/evidence completion path
7. Add Observation and Warning records
8. Add basic Mission + Objective graph
9. Add Project linkage for bounded world-changing work
10. Add deterministic candidate filtering/scoring + switching hysteresis
11. Run deterministic two-agent contention/blocker/request scenario
12. Add save/restart + actor-death swarm recovery scenario
13. Only then expose the in-game Message Board UI and live multi-agent model behavior
```

Every new coordination capability follows the same rule as the NPC harness:

```text
schema/state-machine test
→ deterministic harness test
→ real Factorio multi-actor scenario
→ only then build more intelligence on top
```

---

# 21. Explicitly deferred

Do not make V1 depend on:

- a unified inference/API routing gateway;
- heterogeneous model assignment;
- permanent worker roles;
- agent reputation/skill learning;
- complex auctions/market economics;
- generalized distributed database infrastructure;
- broad production-capacity reservations before contention requires them;
- unrestricted whole-map shared knowledge;
- natural-language inter-agent chat as an authoritative coordination protocol.

These may become useful later, but the first swarm milestone is a reliable shared coordination substrate.

---

# TL;DR

Use a structured Blackboard as the backend for the in-game Message Board. Agents remain general-purpose and temporarily claim useful work through revision-protected simulation-time leases. The Mission Tracker owns desired outcomes and dependency graphs; Projects bound world-changing implementation; Work Items and Requests coordinate what needs to happen now. Results and observations provide evidence back upward. Work priority, locality, inventory fit, dependency value, switching cost, and emergencies allow agents to change activity dynamically without fixed jobs. Preserve this state with the Factorio world and prove contention, blocking, request handoff, recovery, and save/restart deterministically before adding sophisticated model routing or swarm intelligence.
