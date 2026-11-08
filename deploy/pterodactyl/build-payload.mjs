#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, 'payload-src', 'installer.sh')
const installPath = join(here, 'install.sh')
const mainEggPath = join(here, 'egg-sgluna-factorio-server.json')
const e2eEggPath = join(here, 'egg-sgluna-factorio-npc-e2e.json')
const LEGACY_SOURCE_PIN = '78ef2acf788189981d82aa9e15e9c33b3dedb29c'

// Immutable commit containing the audited installer payload. When payload-src/installer.sh
// changes, repin this in a follow-up commit to a commit that already contains the exact
// payload bytes; otherwise the bootstrap checksum and immutable source can diverge.
// Channel eggs keep this bootstrap immutable, then resolve SGLUNA_SOURCE_REF to an exact
// commit at reinstall time and patch only the payload's SGLUNA_REF/revision assignments.
const PAYLOAD_REF = '9f739d39a658ee339d4fc700de318d9001ab7b62'
const CHANNELS = Object.freeze({
  main: {
    name: 'SGLuna Factorio Server (Main)',
    description: 'Stable SGLuna Factorio channel. Reinstall resolves the latest main commit to an exact SHA, validates/builds it transactionally, and records that SHA in the installed manifest. Restart never updates code.',
    sourceRef: 'main',
    release: 'main',
  },
  npcE2e: {
    name: 'SGLuna Factorio Server (NPC E2E / Jev Experiment)',
    description: 'SGLuna internal plan channel from the shared main codebase. Reinstall resolves main to an exact SHA. Harness mode is selected at startup; live experimentation requires separate authorization.',
    sourceRef: 'main',
    release: 'npc-e2e',
  },
})

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertNpcV8Source(source) {
  const text = source.toString('utf8')
  const failures = []
  if (!text.includes('sgluna-deploy-v8')) failures.push('missing v8 deployment revision')
  if (!text.includes('SGLUNA_ACTOR_MODE')) failures.push('missing SGLUNA_ACTOR_MODE')
  if (!text.includes('SGLUNA_CHAT_PLAYERS')) failures.push('missing SGLUNA_CHAT_PLAYERS')
  if (!/SGLUNA_REF="[a-f0-9]{40}"/.test(text)) failures.push('missing immutable SGLUNA_REF pin')
  if (text.includes('airi-deploy-v7')) failures.push('contains v7 deployment guard')
  if (text.includes('explicit-authorized-single-connected-player')) failures.push('contains connected-player patch contract')
  if (text.includes(`SGLUNA_REF="${LEGACY_SOURCE_PIN}"`)) failures.push('pins the legacy connected-player source')
  if (text.includes('operationCommands')) failures.push('contains legacy operationCommands model contract')
  if (failures.length) throw new Error(`Refusing to generate v8 artifacts: ${failures.join('; ')}`)
}

export function installerLoader(source) {
  assertNpcV8Source(source)
  const sourceHash = sha256(source)
  return `#!/usr/bin/env bash
# Generated SGLuna Factorio standalone-NPC v8 installer loader.
# Immutable source: deploy/pterodactyl/payload-src/installer.sh
set -Eeuo pipefail
umask 077
REF="${PAYLOAD_REF}"
EXPECTED_SOURCE_SHA256="${sourceHash}"
URL="https://raw.githubusercontent.com/TTLouis/factorio-npc/$REF/deploy/pterodactyl/payload-src/installer.sh"
TMP="$(mktemp)"
log() { printf '[SGLuna bootstrap] %s\\n' "$*"; }
fail() { log "ERROR: $*" >&2; exit 78; }
cleanup() { local code=$?; trap - EXIT; rm -f -- "$TMP"; exit "$code"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
for tool in bash curl sha256sum awk mktemp rm; do command -v "$tool" >/dev/null || fail "Missing installer loader tool: $tool"; done
curl --fail --location --retry 3 --connect-timeout 20 --max-time 900 --proto '=https' --proto-redir '=https' "$URL" --output "$TMP" || fail 'Unable to download pinned SGLuna installer source'
ACTUAL_SOURCE_SHA256="$(sha256sum "$TMP" | awk '{print $1}')"
[[ "$ACTUAL_SOURCE_SHA256" == "$EXPECTED_SOURCE_SHA256" ]] || fail 'Pinned SGLuna installer source checksum mismatch'
if [[ "\${1:-}" == '--verify-only' ]]; then log "Pinned payload verified at $REF; installation was not run."; exit 0; fi
[[ $# == 0 ]] || fail 'Only --verify-only is supported as a loader argument.'
log "Using immutable installer payload $REF"
bash "$TMP"
`
}

export function channelInstaller(source, channel) {
  assertNpcV8Source(source)
  const config = CHANNELS[channel]
  if (!config) throw new Error(`Unknown Pterodactyl channel: ${channel}`)
  return `#!/usr/bin/env bash
# Generated SGLuna Factorio channel installer: ${config.release}
# Reinstall follows ${config.sourceRef}; restart keeps the installed exact SHA.
# The installer payload is loaded from that same resolved commit, so an egg
# re-import is not required when deployment code changes on the tracked ref.
set -Eeuo pipefail
umask 077
DEFAULT_SOURCE_REF="${config.sourceRef}"
CHANNEL="${config.release}"
SOURCE_REF="$DEFAULT_SOURCE_REF"
SOURCE_REF_ORIGIN="default"
if [[ -n "\${SGLUNA_SOURCE_REF:-}" ]]; then
  SOURCE_REF="$SGLUNA_SOURCE_REF"
  SOURCE_REF_ORIGIN="sgluna"
elif [[ -n "\${AIRI_SOURCE_REF:-}" ]]; then
  SOURCE_REF="$AIRI_SOURCE_REF"
  SOURCE_REF_ORIGIN="airi"
fi
BASE="$(mktemp)"
PATCHED="$(mktemp)"
RESOLUTION="$(mktemp)"
log() { printf '[SGLuna channel:%s] %s\\n' "$CHANNEL" "$*"; }
fail() { log "ERROR: $*" >&2; exit 78; }
if [[ "$SOURCE_REF_ORIGIN" == "airi" ]]; then log 'Using legacy AIRI_SOURCE_REF compatibility fallback; prefer SGLUNA_SOURCE_REF.'; fi
if [[ -n "\${SGLUNA_SOURCE_REF:-}" && -n "\${AIRI_SOURCE_REF:-}" && "$SGLUNA_SOURCE_REF" != "$AIRI_SOURCE_REF" ]]; then
  log 'Compatibility warning: SGLUNA_SOURCE_REF overrides conflicting AIRI_SOURCE_REF.'
fi
cleanup() { local code=$?; trap - EXIT; rm -f -- "$BASE" "$PATCHED" "$RESOLUTION"; exit "$code"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
for tool in bash curl awk grep mktemp rm tr; do command -v "$tool" >/dev/null || fail "Missing channel installer tool: $tool"; done
[[ -n "$SOURCE_REF" && "$SOURCE_REF" != -* && "$SOURCE_REF" != */../* && "$SOURCE_REF" != ../* && "$SOURCE_REF" != */.. && "$SOURCE_REF" != *' '* ]] || fail 'Invalid SGLUNA_SOURCE_REF'
if [[ "$SOURCE_REF" =~ ^[a-f0-9]{40}$ ]]; then
  RESOLVED_SHA="$SOURCE_REF"
else
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 60 --proto '=https' --proto-redir '=https' \\
    --get --data-urlencode "sha=$SOURCE_REF" --data-urlencode 'per_page=1' \\
    'https://api.github.com/repos/TTLouis/factorio-npc/commits' --output "$RESOLUTION" \\
    || fail "Unable to resolve SGLUNA_SOURCE_REF=$SOURCE_REF"
  RESOLVED_SHA="$(grep -m1 -oE '\"sha\"[[:space:]]*:[[:space:]]*\"[a-f0-9]{40}\"' "$RESOLUTION" | grep -oE '[a-f0-9]{40}' || true)"
  [[ "$RESOLVED_SHA" =~ ^[a-f0-9]{40}$ ]] || fail "SGLUNA_SOURCE_REF did not resolve to a commit: $SOURCE_REF"
fi
log "Resolved $SOURCE_REF -> $RESOLVED_SHA"
URL="https://raw.githubusercontent.com/TTLouis/factorio-npc/$RESOLVED_SHA/deploy/pterodactyl/payload-src/installer.sh"
curl --fail --location --retry 3 --connect-timeout 20 --max-time 900 --proto '=https' --proto-redir '=https' "$URL" --output "$BASE" \\
  || fail 'Unable to download SGLuna installer payload from resolved source commit'
[[ "$(grep -Ec '^SGLUNA_REF="[a-f0-9]{40}"$' "$BASE")" == 1 && "$(grep -c '^SGLUNA_REF=' "$BASE")" == 1 ]] || fail 'Unexpected SGLUNA_REF assignment contract in resolved installer payload'
[[ "$(grep -Ec '^REVISION="[A-Za-z0-9._-]+"$' "$BASE")" == 1 && "$(grep -c '^REVISION=' "$BASE")" == 1 ]] || fail 'Unexpected REVISION assignment contract in resolved installer payload'
SHORT_SHA="\${RESOLVED_SHA:0:12}"
awk -v ref="$RESOLVED_SHA" -v revision="$CHANNEL-$SHORT_SHA" '
  /^SGLUNA_REF=/ { print "SGLUNA_REF=\\\"" ref "\\\""; next }
  /^REVISION=/ { print "REVISION=\\\"" revision "\\\""; next }
  { print }
' "$BASE" > "$PATCHED"
grep -Fxq "SGLUNA_REF=\\\"$RESOLVED_SHA\\\"" "$PATCHED" || fail 'Failed to apply resolved source SHA'
grep -Fxq "REVISION=\\\"$CHANNEL-$SHORT_SHA\\\"" "$PATCHED" || fail 'Failed to apply channel release revision'
log "Installing exact source $RESOLVED_SHA from $SOURCE_REF"
bash "$PATCHED"
`
}

function variable(name, description, envVariable, defaultValue, rules, { viewable = true } = {}) {
  return {
    name,
    description,
    env_variable: envVariable,
    default_value: defaultValue,
    user_viewable: viewable,
    user_editable: true,
    rules,
    field_type: 'text',
  }
}

function egg(installScript, channel) {
  const config = CHANNELS[channel]
  const decisionProviderVariables = channel === 'npcE2e'
    ? [
        variable('TypeSafe API Key', 'Optional Jev/System One decision-provider credential. Leave blank to disable the decision lane. Kept environment-only and never written to sgluna-config.json.', 'TYPESAFE_API_KEY', '', 'nullable|string|max:512', { viewable: false }),
        variable('Jev Decision Model', 'TypeSafe System One model used for bounded decision routing when a TypeSafe API key is present.', 'DECISION_PROVIDER_MODEL', 'jev-latest', 'required|string|max:200'),
        variable('Max Jev Requests Per Hour', 'Persisted hourly cap for Jev decision-provider calls. Separate from the main planner provider budget.', 'MAX_DECISION_PROVIDER_REQUESTS_PER_HOUR', '600', 'required|numeric|between:1,1200'),
      ]
    : []
  return {
    _comment: 'DO NOT EDIT: generated by deploy/pterodactyl/build-payload.mjs',
    meta: { version: 'PTDL_v2', update_url: null },
    exported_at: '2026-09-14T00:00:00+00:00',
    name: config.name,
    author: 'noreply@ttlouis.space',
    description: config.description,
    features: [],
    docker_images: {
      'ghcr.io/ptero-eggs/yolks:debian_bookworm': 'ghcr.io/ptero-eggs/yolks:debian_bookworm',
    },
    file_denylist: [],
    startup: 'bash ./start-sgluna.sh',
    config: {
      files: '{}',
      startup: '{"done": "SGLuna Factorio ready"}',
      logs: '{}',
      stop: '^C',
    },
    scripts: {
      installation: {
        script: installScript,
        container: 'ghcr.io/ptero-eggs/yolks:debian_bookworm',
        entrypoint: 'bash',
      },
    },
    variables: [
      variable('SGLuna Source Ref', `Git branch, tag, or exact 40-character commit SHA followed when this ${config.release} egg is reinstalled. Restart does not resolve or update this ref.`, 'SGLUNA_SOURCE_REF', config.sourceRef, 'required|string|max:200'),
      variable('Harness Mode', 'Lifecycle from the shared codebase. plan manages the server; external and pursuit connect to an already prepared running Factorio host. Stop and reconcile before changing modes.', 'SGLUNA_HARNESS_MODE', 'plan', 'required|string|in:external,plan,pursuit'),
      variable('Pursuit Profile', 'Absolute path to a private non-secret pursuit profile JSON; required only for pursuit mode. Provider/session secrets remain environment-only.', 'SGLUNA_PURSUIT_PROFILE', '', 'nullable|string|max:1024'),
      variable('Operator RCON Host', 'External/pursuit only: loopback address of the already running prepared Factorio host. This does not start a server or enable remote RCON.', 'SGLUNA_RCON_HOST', '127.0.0.1', 'nullable|string|in:127.0.0.1,::1'),
      variable('RCON Port', 'External/pursuit: explicitly set the existing host RCON port (normally 27015). Blank preserves plan-mode automatic port selection; this field does not start a host.', 'SGLUNA_RCON_PORT', '', 'nullable|numeric|between:1,65535'),
      variable('RCON Password', 'External/pursuit: credential for the existing host. Optional in plan mode, which retains its generated-password default. Environment-only; never put it in the pursuit profile.', 'SGLUNA_RCON_PASSWORD', '', 'nullable|string|max:256', { viewable: false }),
      variable('Operator World Session', 'External/pursuit only: the existing bound world-unique session ID (32-120 letters, digits, underscore or hyphen). Preserve it with the save and journal; startup never binds a different world.', 'EXTERNAL_HARNESS_SESSION', '', 'nullable|string|min:32|max:120'),
      variable('Operator State Directory', 'External/pursuit only: private durable absolute path for the paired world operation journal. Preserve it with the save; external and pursuit share its process lock.', 'EXTERNAL_HARNESS_STATE_DIR', '', 'nullable|string|max:1024'),
      variable('Pursuit Provider Base', 'Pursuit only: existing operator provider base URL. Required by pursuit startup; no provider is called by external mode. Keep credentials in the separate gateway-key field.', 'OPERATOR_PROVIDER_BASE', '', 'nullable|string|url|max:1024'),
      variable('Pursuit Gateway Key', 'Pursuit only: injected operator provider credential. Required by pursuit startup, kept environment-only and never written to profile or evidence.', 'CLI_PROXY_GATEWAY_KEY', '', 'nullable|string|max:1024', { viewable: false }),
      variable('SGLuna Actor Mode', 'Controlled actor mode. The v8 egg intentionally supports standalone NPC ownership only.', 'SGLUNA_ACTOR_MODE', 'npc', 'required|string|in:npc'),
      variable('SGLuna Chat Players', 'Players allowed to issue !luna commands. Default none disables in-game commands until an allowlist is configured. Enter comma-separated exact player names for an allowlist, or use * to explicitly allow everyone. Legacy !airi remains accepted as a compatibility alias.', 'SGLUNA_CHAT_PLAYERS', 'none', 'nullable|string|max:512'),
      variable('OpenAI API Key', 'Plan-mode provider credential; plan startup validates it. External mode needs none. Pursuit uses its separately injected operator provider settings. Kept environment-only.', 'OPENAI_API_KEY', '', 'nullable|string|max:512', { viewable: false }),
      variable('AI Model', 'Plan mode only; pursuit selects its model from the explicit profile. Comma-separated OpenAI-compatible model identifiers. The first entry is the main agent model, used exactly as a single model always was. A second entry names the subagent/plan-agent model for later use; extra entries are validated but otherwise unused today.', 'OPENAI_MODEL', 'replace-me', 'nullable|string|max:200'),
      variable('Provider Base URL', 'Plan-mode OpenAI-compatible API base URL; plan startup validates it. External needs none; pursuit uses separately injected OPERATOR_PROVIDER_BASE and CLI_PROXY_GATEWAY_KEY. Replace the non-routable placeholder. The direct and router AI API methods require HTTPS; the local method also allows plain http to localhost/127.0.0.1/[::1]/host.docker.internal.', 'OPENAI_API_BASEURL', 'https://provider.invalid/v1', 'nullable|string|url|max:255'),
      variable('AI API Method', 'Wire contract for the AI Model endpoint: direct detects the format from the URL and model; router uses the OpenRouter capability profile; local uses the LM Studio-style capability profile; cli-proxy uses upstream provider inference through CLIProxyAPI at any HTTPS endpoint, independently of hosting or tunneling. local and cli-proxy allow plain http only to loopback, host.docker.internal, or .ts.net Tailscale hosts. direct and router require HTTPS. Leave blank to keep this server’s existing behaviour unchanged (the legacy Provider Capability Profile, if any was set, keeps working exactly as before).', 'AI_API_METHOD', '', 'nullable|string|in:direct,router,local,cli-proxy'),
      variable('Provider Timeout (ms)', 'Maximum time for one provider response before the SGLuna turn is cancelled and reported in game.', 'PROVIDER_TIMEOUT_MS', '300000', 'required|numeric|between:1000,600000'),
      ...decisionProviderVariables,
      variable('Save File Name', 'Save under /saves. Leave blank to use the newest existing save or create sgluna-world.zip.', 'SAVE_NAME', '', 'nullable|string|max:160'),
      variable('Factorio Username', 'Factorio.com username used for public server listing. Leave both username and token blank for a hidden/private server.', 'FACTORIO_USERNAME', '', 'nullable|string|max:128'),
      variable('Factorio Authentication Token', 'Factorio.com authentication token used for public server listing. Leave both username and token blank for a hidden/private server.', 'FACTORIO_TOKEN', '', 'nullable|string|max:128', { viewable: false }),
      variable('Max AI Requests Per Hour', 'Persisted hourly provider request cap. Ordinary requests preserve one slot inside this same cap for exactly-once output-budget recovery.', 'MAX_PROVIDER_REQUESTS_PER_HOUR', '300', 'required|numeric|between:1,1200'),
      variable('Max AI Output Tokens Per Turn', 'Aggregate provider-reported completion-token safety cap across one logical planner turn, including bounded recovery. Missing/incomplete usage remains diagnostic rather than being treated as zero.', 'MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN', '100000', 'required|numeric|between:1000,200000'),
      variable('Shutdown Timeout (ms)', 'Graceful Factorio save/stop timeout before forced termination.', 'SHUTDOWN_TIMEOUT_MS', '60000', 'required|numeric|between:1000,300000'),
      variable('Factorio Version', 'Supported Factorio headless version: 2.1.24. Release selectors must resolve to this exact version.', 'FACTORIO_VERSION', '2.1.24', 'required|string|max:20'),
    ],
  }
}

export function buildArtifacts(source) {
  const installScript = installerLoader(source)
  const mainEggJson = `${JSON.stringify(egg(channelInstaller(source, 'main'), 'main'), null, 4)}\n`
  const e2eEggJson = `${JSON.stringify(egg(channelInstaller(source, 'npcE2e'), 'npcE2e'), null, 4)}\n`
  return { installScript, mainEggJson, e2eEggJson }
}

function normalizeCheckoutText(text) {
  return text.replaceAll('\r\n', '\n')
}

function verifyEgg(text, expectedText, expectedChannel) {
  const normalized = normalizeCheckoutText(text)
  let parsed
  try { parsed = JSON.parse(normalized) }
  catch (error) { throw new Error(`Generated ${expectedChannel} egg JSON is invalid: ${error.message}`) }
  if (normalized !== expectedText) throw new Error(`Generated ${expectedChannel} egg schema is stale`)
  const sourceRef = parsed.variables?.find(entry => entry.env_variable === 'SGLUNA_SOURCE_REF')
  if (sourceRef?.default_value !== CHANNELS[expectedChannel].sourceRef) throw new Error(`Generated ${expectedChannel} egg has the wrong source ref`)
  if (!parsed.scripts?.installation?.script?.includes(`CHANNEL="${CHANNELS[expectedChannel].release}"`)) throw new Error(`Generated ${expectedChannel} egg has the wrong channel loader`)
  return parsed
}

export function verifyGeneratedArtifacts(source, installText, mainEggText, e2eEggText) {
  assertNpcV8Source(source)
  const currentInstall = normalizeCheckoutText(installText)
  const expected = buildArtifacts(source)
  if (currentInstall !== expected.installScript) throw new Error('Generated install.sh loader is stale')
  verifyEgg(mainEggText, expected.mainEggJson, 'main')
  verifyEgg(e2eEggText, expected.e2eEggJson, 'npcE2e')
  return true
}

function main() {
  const checkOnly = process.argv.includes('--check')
  if (process.argv.length > 3 || (process.argv.length === 3 && !checkOnly)) throw new Error('Usage: node build-payload.mjs [--check]')
  const source = readFileSync(sourcePath)
  if (checkOnly) {
    verifyGeneratedArtifacts(
      source,
      readFileSync(installPath, 'utf8'),
      readFileSync(mainEggPath, 'utf8'),
      readFileSync(e2eEggPath, 'utf8'),
    )
    console.log('SGLuna Pterodactyl v8 Main + NPC E2E artifacts are current and internally verified.')
    return
  }
  const { installScript, mainEggJson, e2eEggJson } = buildArtifacts(source)
  writeFileSync(installPath, installScript)
  writeFileSync(mainEggPath, mainEggJson)
  writeFileSync(e2eEggPath, e2eEggJson)
  console.log('Generated SGLuna standalone-NPC v8 install.sh plus Main and NPC E2E eggs.')
  console.log(`  payload source sha256: ${sha256(source)}`)
  console.log(`  immutable payload ref: ${PAYLOAD_REF}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
