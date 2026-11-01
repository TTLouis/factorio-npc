import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultModels, validateFrozenModels } from './templates/model-profile.mjs'

export const kitRoot = path.dirname(fileURLToPath(import.meta.url))
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { flag: 'wx' }) }
const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)  }\n`)
const check = (ok, message) => { if (!ok) throw new Error(message) }
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
const hashText = value => sha(value.replaceAll('\r', ''))
export function files(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    check(!entry.isSymbolicLink(), 'Symlinks are forbidden in frozen inputs')
    const name = path.posix.join(prefix, entry.name)
    return entry.isDirectory() ? files(root, name) : [name]
  }).sort()
}

export function definePair({ version = 'aw', date = '2026-10-25', candidate, published, imageId, seeds = [2026102501, 2026102502], models = defaultModels }) {
  check(/^[a-z]{2,8}$/.test(version) && /^\d{4}-\d{2}-\d{2}$/.test(date), 'Invalid version/date')
  check(/^[a-f0-9]{40}$/.test(candidate) && /^[a-f0-9]{40}$/.test(published), 'Exact candidate and published SHA required')
  check(/^sha256:[a-f0-9]{64}$/.test(imageId), 'Immutable image ID required')
  check(seeds.length === 2 && seeds.every(n => Number.isInteger(n) && n > 0 && n <= 0xFFFFFFFF) && seeds[0] !== seeds[1], 'Two explicit distinct nonzero uint32 seeds required')
  const day = date.replaceAll('-', '')
  const pairId = `red-automation-${day}${version}`
  return { schema: 1, pairId, candidate, published, imageId, imageTag: `factorio-npc:run-${version}-${day}`,
    profile: 'normal', factorioVersion: '2.0.77', constructionLimitMs: 3600000,
    measurement: { wallMinutes: 5, gameSpeed: 2, minimumGameMinutes: 10, minimumRedPerGameMinute: 1, nativeUpstream: true },
    models: validateFrozenModels(models), overwatchReasoning: 'low',
    sharedQuota: { reserveRemainingPercent: 5, stopRemainingPercent: 7, owner: 'parent', scope: 'shared account across both lanes', staleAfterMs: 180000 },
    lanes: ['a', 'b'].map((id, i) => ({ id, seed: seeds[i], runId: `red-automation-live-${date}${version}-${id}`,
      project: `${pairId}-${id}`, resourcePrefix: `run-${version}-${id}`, saveName: `red-automation-${version}-${id}-checkpoint`,
      container: `${pairId}-${id}-sgluna-factorio-1`, tunnelPort: 1234 + i * 2, recorderPort: 1235 + i * 2,
      rconHostPort: 27016 + i, rconInternalPort: 27015, gamePort: 34197 + i })) }
}

export function assertNativeSeed(native, expected) {
  check(Number.isInteger(native.seed) && native.seed === expected, 'Frozen native map seed mismatch')
}

export function render(text, bindings) {
  return text.replace(/@@([A-Z][A-Z0-9_]*)@@/g, (_all, key) => {
    check(Object.hasOwn(bindings, key), `Unknown template binding ${key}`)
    return String(bindings[key])
  })
}

export function runtimeManifest(repo, candidate) {
  const installer = git(repo, 'show', `${candidate}:deploy/pterodactyl/payload-src/installer.sh`)
  const out = []
  for (const family of ['runtime-v8', 'staging']) {
    const match = installer.match(new RegExp(`for file in ([^;]+); do\\s*cp "\\$WORK/source/deploy/pterodactyl/${  family  }/\\$file"`))
    check(match, `Cannot enumerate installer ${family} modules`)
    for (const name of match[1].trim().split(/\s+/)) out.push({ family, name, sha256: hashText(git(repo, 'show', `${candidate}:deploy/pterodactyl/${family}/${name}`)) })
  }
  check(out.some(e => e.name === 'role-contracts.mjs') && out.some(e => e.name === 'topology-context.mjs'), 'Required runtime modules absent')
  return out
}

// Freeze only helper inputs, never old run intents, data, traces, saves or compiled runtime.
// The caller supplies a newly reviewed candidate and independently compiled native tree.
export function freezePair({ repo, output, nativeDir, nativeManifest, nativeBuildSource, ...options }) {
  const pair = definePair(options)
  for (const value of [repo, output, nativeDir, nativeManifest]) check(typeof value === 'string' && value.length > 0 && !/["'\r\n\0`$]/.test(value), 'Input paths require literal shell-safe names')
  check(nativeBuildSource === pair.candidate, 'Native compile must name the same reviewed candidate')
  check(git(repo, 'rev-parse', `${pair.candidate}^{commit}`).trim() === pair.candidate, 'Candidate unavailable')
  check(!fs.existsSync(output), 'Refusing to replace an existing pair or historical evidence')
  const expectedNative = json(nativeManifest)
  const actualPaths = files(nativeDir)
  check(JSON.stringify(actualPaths) === JSON.stringify(expectedNative.map(e => e.path).sort()), 'Native manifest path mismatch')
  for (const e of expectedNative) {
    const bytes = fs.readFileSync(path.join(nativeDir, e.path))
    check(sha(/\.(?:lua|json)$/.test(e.path) || e.path === 'LICENSE' ? bytes.toString('utf8').replaceAll('\r', '') : bytes) === e.sha256, 'Native compile hash mismatch')
  }
  const provenance = json(path.join(kitRoot, 'av-provenance.json'))
  for (const e of provenance.copied_helper_inputs) check(sha(fs.readFileSync(path.join(kitRoot, 'templates', e.path))) === e.template_sha256, `Unreviewed template change: ${e.path}`)
  for (const e of provenance.verified_baseline_inputs) check(sha(fs.readFileSync(path.join(kitRoot, 'templates', e.path))) === e.sha256, `Historical baseline fixture changed: ${e.path}`)
  const expectedRuntime = runtimeManifest(repo, pair.candidate)
  const promptHash = hashText(git(repo, 'show', `${pair.candidate}:packages/agent/src/llm/prompt.md`))
  const composeBase = git(repo, 'show', `${pair.candidate}:compose.yml`)
  const composeE2e = git(repo, 'show', `${pair.candidate}:compose.e2e.yml`)
  fs.mkdirSync(output, { recursive: true })
  writeJson(path.join(output, 'pair.json'), pair)
  for (const lane of pair.lanes) {
    const root = path.join(output, lane.id)
    const bindings = { PLANNER_MODEL: pair.models.planner, EXECUTOR_MODEL: pair.models.executor, OVERWATCH_MODEL: pair.models.overwatch,
      ROLE_MODEL_LIST: `${pair.models.planner},${pair.models.executor}`, RUN_ID: lane.runId, PROJECT: lane.project, RESOURCE_PREFIX: lane.resourcePrefix,
      SAVE_NAME: lane.saveName, CANDIDATE: pair.candidate, RECORDER_PORT: lane.recorderPort, TUNNEL_PORT: lane.tunnelPort,
      SEED: lane.seed, IMAGE_ID: pair.imageId, GAME_PORT: lane.gamePort, RCON_HOST_PORT: lane.rconHostPort,
      COMPOSE_BASE_SHA: sha(composeBase), COMPOSE_E2E_SHA: sha(composeE2e),
      LANE: lane.id, REPO: path.resolve(repo).replaceAll('\\', '/'), EVIDENCE: path.resolve(root).replaceAll('\\', '/') }
    bindings.LIVE_COMPOSE_SHA = sha(render(fs.readFileSync(path.join(kitRoot, 'templates/live.compose.yml'), 'utf8'), bindings))
    for (const file of files(path.join(kitRoot, 'templates'))) {
      write(path.join(root, file), render(fs.readFileSync(path.join(kitRoot, 'templates', file), 'utf8'), bindings))
    }
    write(path.join(root, 'candidate-sha.txt'), `${pair.candidate  }\n`)
    write(path.join(root, 'release-image-id.txt'), `${pair.imageId  }\n`)
    writeJson(path.join(root, 'expected-runtime.json'), expectedRuntime)
    write(path.join(root, 'expected-prompt-sha256.txt'), `${promptHash  }\n`)
    writeJson(path.join(root, 'expected-native-mod.json'), expectedNative)
    writeJson(path.join(root, 'lane.json'), { ...lane, pairId: pair.pairId, candidate: pair.candidate, imageId: pair.imageId, models: pair.models, overwatchReasoning: pair.overwatchReasoning })
    writeJson(path.join(root, 'map-gen-settings.json'), { seed: lane.seed })
    write(path.join(root, 'frozen-compose/compose.yml'), composeBase)
    write(path.join(root, 'frozen-compose/compose.e2e.yml'), composeE2e)
    write(path.join(root, 'proxy-tunnel/target-port.txt'), `${lane.tunnelPort  }\n`)
    fs.mkdirSync(path.join(root, 'data/logs'), { recursive: true })
    fs.mkdirSync(path.join(root, 'data/saves'), { recursive: true })
    fs.mkdirSync(path.join(root, 'overwatch'), { recursive: true })
    fs.cpSync(nativeDir, path.join(root, 'independent-native'), { recursive: true, errorOnExist: true, force: false })
    const helperManifest = files(root).filter(p => !p.startsWith('data/') && !p.startsWith('independent-native/')).map(p => ({ path: p, sha256: sha(fs.readFileSync(path.join(root, p))) }))
    writeJson(path.join(root, 'helper-manifest.json'), helperManifest)
    writeJson(path.join(root, 'run-intent.json'), { ...pair, lanes: undefined, ...lane, trials: 1, correctivePrompts: 0, manualResumes: 0, providerRetry: false,
      goal: 'Build a new automated factory that continuously produces at least one automation-science-pack per game minute from natural resources.', nativeBuildSource })
  }
  for (const name of files(path.join(kitRoot, 'coordinator'))) write(path.join(output, name), fs.readFileSync(path.join(kitRoot, 'coordinator', name)))
  const frozen = files(output).filter(p => !p.includes('/data/') && !p.includes('/overwatch/')).map(p => ({ path: p, sha256: sha(fs.readFileSync(path.join(output, p))) }))
  writeJson(path.join(output, 'pair-manifest.json'), frozen)
  return pair
}

// Pure decision layer used by the real coordinator before deleting its unique tag.
// Lane teardown never reaches this function or removes image identities.
export function imageTeardownDecision({ pair, ledger, lanes, containers, networks, volumes, tagId }) {
  check(ledger.pairId === pair.pairId && ledger.imageId === pair.imageId && ledger.imageTag === pair.imageTag && ledger.tagInitiallyAbsent === true, 'Pair image capability mismatch')
  check(pair.lanes.every(l => lanes[l.id]?.cleanupVerified === true && lanes[l.id]?.runId === l.runId), 'Both lane cleanups must finish before image teardown')
  check(!containers.length && !networks.length && !volumes.length, 'Pair resources remain; retain image')
  check(!tagId || tagId === pair.imageId, 'Image tag changed ownership; retain image')
  return { action: tagId ? 'remove_unique_pair_tag' : 'already_absent', imageTag: pair.imageTag, neverForce: true }
}

export function sharedQuotaDecision(pair, quota, now = Date.now()) {
  if (quota?.pairId !== pair.pairId || quota?.source !== 'get_usage_limits' || quota?.observedBy !== 'parent:/root' || quota?.matchingWeeklyWindows !== 1 || quota?.windowDurationMins !== 10080 ||
      !Number.isFinite(quota?.remainingPercent) || quota.remainingPercent < 0 || quota.remainingPercent > 100 || !Number.isFinite(quota?.observedAt) || now < quota.observedAt) return 'shared_quota_evidence_unavailable'
  if (now - quota.observedAt > pair.sharedQuota.staleAfterMs) return 'shared_quota_evidence_stale'
  return quota.remainingPercent <= pair.sharedQuota.stopRemainingPercent ? 'stop_both_shared_quota_floor' : 'continue'
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  check(process.argv[2] === 'freeze' && process.argv[3], 'Usage: node pair.mjs freeze freeze-input.json')
  console.log(JSON.stringify(freezePair(json(process.argv[3])), null, 2))
}
