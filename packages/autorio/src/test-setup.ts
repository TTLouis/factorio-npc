import { event_handlers, set_load_handler } from './test-event-registry'

// Minimal stand-ins for the Factorio/Lua globals that control.ts touches at module
// load time (remote.add_interface, script lifecycle registration, the closing log()
// call) plus the Lua `math` stdlib used by pure logic like get_direction. This lets
// vitest import production modules under Node without a real Factorio runtime; it
// does not attempt to emulate game state.
(globalThis as any).log = () => {}
;(globalThis as any).pairs = Object.entries

;(globalThis as any).remote = {
  interfaces: {},
  add_interface: () => {},
  call: () => undefined,
}

;(globalThis as any).script = {
  on_event: (event_key: unknown, handler: (event: any) => void) => {
    event_handlers.set(event_key, handler)
  },
  on_nth_tick: (_tick: number, _handler: ((event: any) => void) | undefined) => {},
  on_load: (handler: (() => void) | undefined) => {
    set_load_handler(handler)
  },
}

;(globalThis as any).game = {
  connected_players: [],
  get_player: () => undefined,
  surfaces: {
    1: { find_entities_filtered: () => [] },
  },
  print: () => {},
  tick: 0,
  is_multiplayer: () => false,
}

;(globalThis as any).rendering = {
  clear: () => {},
  draw_line: () => {},
}

;(globalThis as any).serpent = {
  line: (value: unknown) => String(value),
  block: (value: unknown) => String(value),
}

;(globalThis as any).helpers = {
  table_to_json: (value: unknown) => JSON.stringify(value),
  // Every sprite the console asks for is one the mod's own data stage declares,
  // so the stand-in answers the way a build that shipped its graphics would.
  is_valid_sprite_path: () => true,
}

;(globalThis as any).string = {
  lower: (value: string) => value.toLowerCase(),
}

// Factorio 2.0 exposes prototype tables globally. Production runtime guards use
// prototypes.entity before calling find_entities_filtered because Factorio throws
// for unknown prototype names. Unit tests only need the common fixture prototypes
// they exercise; deliberately unknown names remain absent and can be rejected.
;(globalThis as any).prototypes = {
  entity: {
    character: {},
    'iron-ore': {},
    'iron-chest': {},
    'wooden-chest': {},
    'steel-chest': {},
    'gun-turret': {},
  },
  item: {
    'iron-plate': {},
    'copper-plate': {},
    boiler: {},
    pipe: {},
    'assembling-machine-1': {},
  },
}

// Factorio 2.0's per-save persistence table. Real shape is declared locally
// by whichever file uses it (see standalone_character_actor.ts); tests just
// need the binding to exist so `storage.foo` doesn't throw ReferenceError.
;(globalThis as any).storage = {}

;(globalThis as any).defines = {
  events: {
    on_selected_entity_changed: 'on_selected_entity_changed',
    on_script_path_request_finished: 'on_script_path_request_finished',
    on_player_mined_entity: 'on_player_mined_entity',
    on_tick: 'on_tick',
    on_player_crafted_item: 'on_player_crafted_item',
    on_research_finished: 'on_research_finished',
    on_player_joined_game: 'on_player_joined_game',
    on_gui_click: 'on_gui_click',
  },
  direction: {
    north: 'north',
    northeast: 'northeast',
    east: 'east',
    southeast: 'southeast',
    south: 'south',
    southwest: 'southwest',
    west: 'west',
    northwest: 'northwest',
  },
  shooting: {
    not_shooting: 'not_shooting',
    shooting_enemies: 'shooting_enemies',
    shooting_selected: 'shooting_selected',
  },
  inventory: {
    character_guns: 'character_guns',
    character_ammo: 'character_ammo',
    character_armor: 'character_armor',
    turret_ammo: 'turret_ammo',
    crafter_input: 'crafter_input',
    crafter_output: 'crafter_output',
    crafter_trash: 'crafter_trash',
    assembling_machine_dump: 'assembling_machine_dump',
  },
  rocket_silo_status: {
    building_rocket: 'building_rocket',
    rocket_ready: 'rocket_ready',
    launch_started: 'launch_started',
  },
}

;(globalThis as any).math = {
  sqrt: Math.sqrt,
  pow: Math.pow,
  atan2: Math.atan2,
  pi: Math.PI,
  huge: Number.POSITIVE_INFINITY,
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  random: (min: number, _max: number) => min,
}
