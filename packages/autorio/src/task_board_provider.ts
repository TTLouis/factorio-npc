import type { SpritePath } from 'factorio:runtime'

/**
 * Which provider SGLuna is currently talking to, and the avatar the console's
 * mod-GUI button wears for it.
 *
 * This lives apart from task_board_ui because TSTL emits each module-scope
 * constant and helper as a Lua local, and that module is already close to
 * Factorio's 200-locals-per-function limit.
 */

interface TaskBoardProvider { id: string, label: string }

declare const storage: {
  // The last model identifier SGLuna reported. A cleared board drops its debug
  // block, and the button must not lose the avatar it earned just because the
  // current goal finished.
  sgluna_task_board_provider_model?: string
  // Which avatar variant each player sees, by player index.
  sgluna_task_board_avatar_roll?: Record<number, number>
}

const AVATAR_PREFIX = 'sgluna-provider-'
// An empty id means no vendor avatar exists for this model, and the button
// keeps whatever sprite it was created with. There is deliberately no SGLuna
// house avatar: the button answers "which vendor is answering", and inventing a
// fourth face for "none of them" would answer a different question.
const UNKNOWN: TaskBoardProvider = { id: '', label: 'Unrecognized provider' }
// Matched against the model identifier in order, so a name carrying two vendor
// words - a proxy prefix, a router path - resolves to the vendor that actually
// answers. Substrings only: model identifiers are provider-defined and change
// faster than any list here can.
// `variants` is how many `<id>-<n>.png` files that provider has. data.lua must
// declare the same count: a variant the resolver can pick but the data stage
// never declared leaves the button blank.
const PROVIDERS: Array<TaskBoardProvider & { keys: string[], variants: number }> = [
  { id: 'deepseek', label: 'DeepSeek', variants: 4, keys: ['deepseek'] },
  { id: 'claude', label: 'Claude', variants: 4, keys: ['claude', 'anthropic', 'sonnet', 'opus', 'haiku'] },
  { id: 'qwen', label: 'Qwen', variants: 4, keys: ['qwen', 'qianwen', 'tongyi'] },
  { id: 'gemini', label: 'Gemini', variants: 4, keys: ['gemini', 'google'] },
  { id: 'openai', label: 'OpenAI', variants: 4, keys: ['openai', 'chatgpt', 'gpt-', 'gpt4', 'gpt3', 'o1-', 'o3-', 'o4-'] },
]

/**
 * The provider a model identifier belongs to. Exported for the unit tests: the
 * mapping is a guess about vendor naming, so it is worth pinning down.
 */
export function task_board_provider_of(model: unknown): TaskBoardProvider {
  const name = String(model ?? '').toLowerCase()
  if (name.length === 0) return UNKNOWN
  for (const provider of PROVIDERS) {
    for (const key of provider.keys) {
      if (name.includes(key)) return { id: provider.id, label: provider.label }
    }
  }
  return UNKNOWN
}

function variants_of(id: string) {
  for (const provider of PROVIDERS) if (provider.id === id) return provider.variants
  return 0
}

/**
 * Roll which avatar variant a player sees. Called when they join, so the
 * console looks a little different each time they come back.
 *
 * Deliberately not `math.random`. GUI rendering is synchronized game state, so
 * the choice has to be one every peer reaches - which rules out anything
 * client-local - and drawing from the map's RNG would advance a synchronized
 * stream from GUI code. Mixing the join tick with the player index is
 * deterministic, free, and varies between sessions because the tick does. The
 * factors are odd and coprime so neighbouring ticks and adjacent players do not
 * land on the same variant.
 */
export function roll_provider_avatar(player_index: number, tick: number) {
  if (storage.sgluna_task_board_avatar_roll === undefined) storage.sgluna_task_board_avatar_roll = {}
  storage.sgluna_task_board_avatar_roll[player_index] = ((tick % 100003) * 131 + player_index * 40503) % 2147483647
}

/** The variant this player sees, 1-based. Rolls one if they never got one. */
export function provider_avatar_variant(player_index: number, id: string) {
  const variants = variants_of(id)
  if (variants <= 1) return 1
  let roll = storage.sgluna_task_board_avatar_roll?.[player_index]
  if (roll === undefined) {
    roll_provider_avatar(player_index, game.tick)
    roll = storage.sgluna_task_board_avatar_roll![player_index]
  }
  return (roll % variants) + 1
}

/** Record the model a snapshot reported. Empty values keep the last known one. */
export function remember_provider_model(model: unknown) {
  const name = String(model ?? '').trim()
  if (name.length > 0) storage.sgluna_task_board_provider_model = name
}

export function current_provider_model() { return storage.sgluna_task_board_provider_model ?? '' }

/**
 * The avatar for the current provider. The avatars are declared as sprites in
 * data.lua; an unrecognized model, or a build that somehow shipped without the
 * graphics, still gets a working button from `fallback` rather than an empty
 * one.
 */
export function provider_button_sprite(player_index: number, fallback: SpritePath): SpritePath {
  const id = task_board_provider_of(current_provider_model()).id
  if (id.length === 0) return fallback
  const avatar = `${AVATAR_PREFIX}${id}-${provider_avatar_variant(player_index, id)}` as SpritePath
  return helpers.is_valid_sprite_path(avatar) ? avatar : fallback
}

/** Button tooltip names only UI-owned provider text; exact model ids are external text. */
export function provider_button_tooltip(base: string) {
  const model = current_provider_model()
  return model.length > 0 ? `${base}\n${task_board_provider_of(model).label}` : base
}
