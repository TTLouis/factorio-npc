import fs from 'node:fs'
import path from 'node:path'

const output = process.argv[2] ?? 'release-out/RELEASE_NOTES.md'
const version = process.env.VERSION
const sourceSha = process.env.SOURCE_SHA
const imageRef = process.env.IMAGE_REF

if (!version || !sourceSha || !imageRef) {
  throw new Error('VERSION, SOURCE_SHA, and IMAGE_REF are required')
}

const code = value => `\`${value}\``
const notes = [
  `## SGLuna Factorio ${version}`,
  '',
  'First packaged prerelease of the standalone-NPC fork. This is a prerelease baseline, not a feature-complete stable release.',
  '',
  '### Deployment artifacts',
  '',
  `- **Pterodactyl:** ${code(`egg-sgluna-factorio-${version}.json`)} is pinned to commit ${code(sourceSha)}. Reinstall stays on this release unless ${code('SGLUNA_SOURCE_REF')} is explicitly changed.`,
  `- **Docker:** ${code(imageRef)}, built from the same exact commit. No ${code('latest')} tag is moved by this prerelease.`,
  `- **Docker Compose:** the repository Compose deployment defaults local builds to ${code('main')}; set ${code('SGLUNA_SOURCE_REF=feat/npc-transition-work')} explicitly for ongoing NPC development.`,
  '',
  '### Validation',
  '',
  'Before publication, this release passed the generated-egg contract, packaged zero-player Pterodactyl install/boot/save/shutdown smoke, the real zero-player Factorio integration harness, and a boot/save/shutdown smoke of the final Docker image.',
  '',
  '### Scope / known limits',
  '',
  `- Standalone single-NPC baseline; ongoing NPC work continues on ${code('feat/npc-transition-work')}.`,
  '- Swarm work is not part of this prerelease.',
  `- Current release image target is ${code('linux/amd64')}.`,
  `- Provider credentials are not bundled; configure ${code('OPENAI_API_KEY')}, ${code('OPENAI_API_BASEURL')}, and ${code('OPENAI_MODEL')} at deployment time.`,
  '',
].join('\n')

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, notes)
