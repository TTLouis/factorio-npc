import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')

function read(relative) {
  return fs.readFile(path.join(repo, relative), 'utf8')
}

function serviceBlock(compose, service) {
  const lines = compose.split(/\r?\n/)
  const start = lines.findIndex(line => line === `  ${service}:`)
  assert.notEqual(start, -1, `missing ${service} service`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_.-]+:\s*$/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function environmentKeys(block) {
  const lines = block.split(/\r?\n/)
  const start = lines.findIndex(line => line === '    environment:')
  assert.notEqual(start, -1, 'missing environment block')
  const keys = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = /^      ([A-Z0-9_]+):/.exec(lines[i])
    if (!match) break
    keys.push(match[1])
  }
  return keys
}

test('devcontainer loads repo-root interpolation and keeps rcon-api secrets and listeners local', async () => {
  const devcontainer = JSON.parse(await read('.devcontainer/devcontainer.json'))
  assert.deepEqual(devcontainer.dockerComposeFile, ['../compose.devcontainer.yml'])
  await assert.rejects(() => read('.devcontainer/docker-compose.yml'), error => error?.code === 'ENOENT')

  const [compose, apiConfig] = await Promise.all([
    read('compose.devcontainer.yml'),
    read('.devcontainer/factorio-rcon-api.yml'),
  ])
  const rconApi = serviceBlock(compose, 'rcon-api')

  assert.match(compose, /context: \.\n/)
  assert.match(compose, /dockerfile: \.devcontainer\/Dockerfile/)
  assert.match(rconApi, /image: ghcr\.io\/nekomeowww\/factorio-rcon-api:2\.0\.6/)
  assert.match(rconApi, /network_mode: host/)
  assert.match(rconApi, /\.\/\.devcontainer\/factorio-rcon-api\.yml:\/app\/api-server\/config\/config\.yaml:ro/)
  assert.deepEqual(environmentKeys(rconApi), [
    'FACTORIO_RCON_HOST',
    'FACTORIO_RCON_PORT',
    'FACTORIO_RCON_PASSWORD',
  ])
  assert.match(rconApi, /FACTORIO_RCON_PASSWORD: \$\{FACTORIO_RCON_PASSWORD:\?set FACTORIO_RCON_PASSWORD in repo-root \.env\}/)
  assert.doesNotMatch(rconApi, /\benv_file\s*:/)
  assert.doesNotMatch(rconApi, /\bOPENAI_API_KEY\b|\bOPENAI_API_BASEURL\b|\bOPENAI_MODEL\b|\bFACTORIO_USERNAME\b|\bFACTORIO_TOKEN\b|\bTYPESAFE_API_KEY\b/)
  assert.doesNotMatch(rconApi, /^    ports:\s*$/m)

  assert.match(apiConfig, /^\s*http_server_addr:\s*["']127\.0\.0\.1:24180["']\s*$/m)
  assert.match(apiConfig, /^\s*grpc_server_addr:\s*["']127\.0\.0\.1:24181["']\s*$/m)
  assert.doesNotMatch(apiConfig, /0\.0\.0\.0/)
})

test('local Compose RCON configs have no password fallback and keep loopback-only published RCON', async () => {
  const [dev, base, e2e, desktop, example, gitignore, dockerignore] = await Promise.all([
    read('compose.devcontainer.yml'),
    read('compose.yml'),
    read('compose.e2e.yml'),
    read('compose.desktop-operator.yml'),
    read('.env.example'),
    read('.gitignore'),
    read('.dockerignore'),
  ])

  assert.match(example, /^FACTORIO_RCON_PASSWORD=\s*$/m)
  assert.match(gitignore, /^\.env\s*$/m)
  assert.match(dockerignore, /^\.env\s*$/m)
  assert.match(dockerignore, /^\.env\.\*\s*$/m)
  assert.match(e2e, /SGLUNA_RCON_PASSWORD: \$\{FACTORIO_RCON_PASSWORD:\?/)
  assert.match(desktop, /SGLUNA_RCON_PASSWORD: \$\{FACTORIO_RCON_PASSWORD:\?/)
  assert.match(e2e, /127\.0\.0\.1:\$\{SGLUNA_RCON_HOST_PORT:-27015\}:\$\{SGLUNA_RCON_PORT:-27015\}\/tcp/)
  assert.match(desktop, /127\.0\.0\.1:\$\{DESKTOP_OPERATOR_HOST_PORT:-24181\}:24181\/tcp/)
  assert.doesNotMatch(base, /\bRCON\b|27015/)
  assert.doesNotMatch([dev, base, e2e, desktop, example].join('\n'), /\b123456\b/)
})
