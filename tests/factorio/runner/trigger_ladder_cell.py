#!/usr/bin/env python3
"""Trigger ladder: every research-trigger technology under the red/green science closure
must complete from a FRESH world through the NPC's own bounded operations.

Why: the live "automate red science" run kept getting the tech tree wrong. The existing
`craft-trigger` lane seeds steam-power and electronics as researched and only exercises
the last craft-item trigger (lab). Nobody had shown that the earlier triggers complete
natively, with nothing researched, for a standalone character with no player.

What this cell does, with nothing researched and zero connected players:
  a) reads from the ENGINE the full prerequisite closure of automation-science-pack and
     logistic-science-pack, with each technology's research_trigger (type, item/entity,
     count) or lab unit cost. Nothing about which techs exist is hard-coded here.
  b) walks the closure in prerequisite order. For each trigger technology whose
     prerequisites are researched the NPC performs EXACTLY the trigger through the same
     remote operations the runtime uses (craft_item, place_entity, supply_entity,
     move_items_exact, wait). Dispatch is on the trigger type. A craft-item trigger for a
     smelting product is produced by a real placed, fuelled stone furnace that the NPC
     fed; a hand-craftable item is produced by the native hand-crafting queue.
  c) after the trigger it polls a bounded time and asserts the technology is researched
     and its unlocked recipes are enabled. Nothing here writes `technology.researched`,
     research progress, or the trigger's target item.
  d) lab technologies (unit cost) are listed as `lab_research_not_exercised`.
  e) a trigger type this cell cannot drive, an item the NPC cannot produce, or a
     technology that does not complete after the exact trigger fails the cell with a
     named FINDING line plus the engine production statistics and the mod's own counters.

Fixture (declared, and repeated in the JSON as `seeded_raw_inputs`): only RAW inputs are
put into the NPC's inventory (ore, coal, stone), each checked against the engine to be a
mineable resource product. Plates, furnaces, gears, circuits, belts and the lab are all
produced by the NPC. game.speed is raised to 4 as smelting_transfer.py does.

The engine's `on_research_finished.by_script` flag cannot be captured from this cell (an
RCON command cannot register an event handler and the mod keeps no handler for trigger
completions). The substitute evidence is that this file never writes any research state.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, remote_call
from runtime import operation_status_command, wait_until_idle

GAME_SPEED = 4
POLL_AFTER_TRIGGER_SECONDS = 10.0
FUEL_ITEM = 'coal'
FURNACE = 'stone-furnace'
TARGETS = ('automation-science-pack', 'logistic-science-pack')


class Finding(AssertionError):
    """A named, evidence-carrying failure; the message starts with `FINDING <name>`."""


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(json.dumps(message, sort_keys=True) if not isinstance(message, str) else message)


def topological_order(techs: dict[str, dict]) -> list[str]:
    """Prerequisite order over the engine-reported closure (stable by name)."""
    remaining = {name: set(tech.get('prerequisites') or []) & set(techs) for name, tech in techs.items()}
    ordered: list[str] = []
    while remaining:
        ready = sorted(name for name, deps in remaining.items() if not deps)
        require(bool(ready), {'cycle_in_closure': sorted(remaining)})
        for name in ready:
            ordered.append(name)
            del remaining[name]
        for deps in remaining.values():
            deps.difference_update(ready)
    return ordered


def trigger_item_name(trigger: dict) -> str | None:
    """ItemIDFilter may be a bare name or a table with a name and quality."""
    value = trigger.get('item')
    if isinstance(value, dict):
        return value.get('name')
    return value if isinstance(value, str) else None


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()
    evidence: dict[str, Any] = {
        'status': 'fail',
        'scenario': 'trigger-ladder',
        'actor_id': actor_id,
        'fixture': 'raw inputs only (ore, coal, stone) seeded into the NPC inventory; everything else produced by the NPC',
        'seeded_raw_inputs': [],
        'closure': [],
        'order': [],
        'lab_research_not_exercised': [],
        'results': {},
        'findings': [],
    }

    def flush() -> None:
        evidence['transcript'] = transcript[-120:]
        (results / 'trigger-ladder-cell.json').write_text(json.dumps(evidence, indent=2))

    def command(text: str, context: str) -> Any:
        response = client.command(text)
        transcript.append({'elapsed_seconds': round(time.monotonic() - started, 3), 'context': context, 'command': text[:600], 'response': response[:1500]})
        flush()
        return decode_json(response, context)

    find_actor = (
        "local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a and a.valid); local f=a.force; "
    )

    def lua(body: str, context: str) -> Any:
        return command('/silent-command ' + find_actor + body, context)

    def operation_status(context: str) -> dict:
        return command(operation_status_command(), context)

    def admission(expression: str, context: str) -> dict:
        # Scalar-boolean and [boolean, message] admissions both exist on the remote surface.
        return command(
            '/silent-command local result=' + expression + '; local accepted=false; local message=nil; '
            "if type(result)=='table' then accepted=result[1]==true; message=result[2] else accepted=result==true end; "
            'rcon.print(helpers.table_to_json({accepted=accepted,message=message}))',
            f'{context} admission',
        )

    def run_operation(expression: str, context: str, timeout: float = 30.0) -> dict:
        result = admission(expression, context)
        require(result.get('accepted') is True, {'context': context, 'admission': result})
        return wait_until_idle(operation_status, context, timeout)

    def last_result(status: dict) -> dict:
        return (status.get('basic_operation') or {}).get('last_result') or {}

    def clock() -> dict:
        return command(
            '/silent-command rcon.print(helpers.table_to_json({tick=game.tick,connected=#game.connected_players,speed=game.speed}))',
            'clock',
        )

    # ---- engine facts -------------------------------------------------------------------
    targets_lua = '{' + ','.join(f"'{n}'" for n in TARGETS) + '}'
    closure_list = lua(
        "local out={}; local seen={}; local queue={}; "
        f"for _,n in ipairs({targets_lua}) do queue[#queue+1]=n; seen[n]=true end "
        "while #queue>0 do local name=table.remove(queue,1); local t=f.technologies[name]; assert(t, name); "
        "local pre={}; for pname,_ in pairs(t.prerequisites) do pre[#pre+1]=pname; "
        "if not seen[pname] then seen[pname]=true; queue[#queue+1]=pname end end table.sort(pre); "
        "local unlocks={}; for _,e in ipairs(t.prototype.effects or {}) do if e.type=='unlock-recipe' then unlocks[#unlocks+1]=e.recipe end end "
        "local entry={name=name,prerequisites=pre,researched=t.researched,enabled=t.enabled,unlocks=unlocks,"
        "research_trigger=t.prototype.research_trigger}; "
        "if not t.prototype.research_trigger then entry.unit_count=t.research_unit_count; "
        "local ing={}; for _,i in ipairs(t.research_unit_ingredients) do ing[#ing+1]={name=i.name,amount=i.amount} end entry.unit_ingredients=ing end "
        "out[#out+1]=entry end "
        "rcon.print(helpers.table_to_json({humans=#game.connected_players,techs=out}))",
        'engine closure',
    )
    require(closure_list['humans'] == 0, closure_list)
    techs = {entry['name']: entry for entry in closure_list['techs']}
    evidence['closure'] = [techs[n] for n in sorted(techs)]
    order = topological_order(techs)
    evidence['order'] = order
    require(all(not techs[n]['researched'] for n in techs), {'message': 'closure is not fresh', 'techs': techs})
    flush()

    # Raw-input proof: an item may be seeded only if the engine says a resource or tree yields it.
    raw_cache: dict[str, bool] = {}

    def is_engine_raw(item: str) -> bool:
        if item not in raw_cache:
            raw_cache[item] = bool(lua(
                "local found=false; for _,t in ipairs({'resource','tree'}) do "
                "for name,proto in pairs(prototypes.get_entity_filtered{{filter='type',type=t}}) do "
                "local mp=proto.mineable_properties; if mp and mp.minable then for _,p in ipairs(mp.products or {}) do "
                f"if p.name=='{item}' then found=true end end end end end "
                "rcon.print(helpers.table_to_json({found=found}))",
                f'engine raw check {item}',
            )['found'])
        return raw_cache[item]

    char_categories = lua(
        "local c={}; for name,_ in pairs(prototypes.entity['character'].crafting_categories) do c[#c+1]=name end "
        "table.sort(c); rcon.print(helpers.table_to_json({categories=c}))",
        'character crafting categories',
    )['categories']
    evidence['character_crafting_categories'] = char_categories

    recipe_cache: dict[str, list[dict]] = {}

    def recipes_for(item: str) -> list[dict]:
        if item not in recipe_cache:
            recipe_cache[item] = lua(
                "local out={}; for name,r in pairs(f.recipes) do local makes=false; "
                f"for _,p in ipairs(r.products) do if p.name=='{item}' and p.type=='item' then makes=true end end "
                "if makes then local ing={}; for _,i in ipairs(r.ingredients) do ing[#ing+1]={type=i.type,name=i.name,amount=i.amount} end "
                "local prod={}; for _,p in ipairs(r.products) do prod[#prod+1]={type=p.type,name=p.name,amount=p.amount,amount_min=p.amount_min,amount_max=p.amount_max,probability=p.probability} end "
                "out[#out+1]={name=name,category=r.category,enabled=r.enabled,hidden=r.hidden,energy=r.energy,ingredients=ing,products=prod} end end "
                "table.sort(out,function(x,y) return x.name<y.name end) rcon.print(helpers.table_to_json({recipes=out}))",
                f'recipes producing {item}',
            )['recipes']
        return recipe_cache[item]

    def product_amount(recipe: dict, item: str) -> float:
        for product in recipe['products']:
            if product['name'] == item and product['type'] == 'item':
                require(product.get('probability') in (None, 1) and product.get('amount') is not None, {'uncertain_product': product})
                return float(product['amount'])
        raise AssertionError({'recipe_without_product': recipe['name'], 'item': item})

    def smelting_recipe(item: str) -> dict | None:
        found = [r for r in recipes_for(item) if r['category'] == 'smelting' and not r.get('hidden')]
        return found[0] if found else None

    def hand_recipe(item: str) -> dict | None:
        found = [
            r for r in recipes_for(item)
            if r['category'] in char_categories and not r.get('hidden') and all(i['type'] == 'item' for i in r['ingredients'])
            and any(p['name'] == item and p['type'] == 'item' and p.get('probability') in (None, 1) and p.get('amount') is not None for p in r['products'])
        ]
        found.sort(key=lambda r: (r['name'] != item, not r['enabled'], r['name']))
        return found[0] if found else None

    def expand_hand_craft(item: str, count: int, leaves: dict[str, int], path: list[dict]) -> None:
        """Leaves are smelted plates or raw items; everything between is hand-crafted."""
        if smelting_recipe(item) is not None:
            leaves[item] = leaves.get(item, 0) + count
            return
        if is_engine_raw(item):
            leaves[item] = leaves.get(item, 0) + count
            return
        recipe = hand_recipe(item)
        if recipe is None:
            raise Finding(f'FINDING item_not_producible_by_npc item={item} count={count}')
        crafts = math.ceil(count / product_amount(recipe, item))
        path.append({'recipe': recipe['name'], 'crafts': crafts, 'enabled_at_plan_time': recipe['enabled']})
        for ingredient in recipe['ingredients']:
            expand_hand_craft(ingredient['name'], int(crafts * ingredient['amount']), leaves, path)

    # ---- world/inventory helpers ----------------------------------------------------------
    def inventory_count(item: str) -> int:
        return int(lua(f"rcon.print(helpers.table_to_json({{count=a.get_item_count('{item}')}}))", f'inventory {item}')['count'])

    def seed_raw(item: str, count: int, reason: str) -> None:
        require(is_engine_raw(item), {'seed_refused_not_engine_raw': item})
        if count <= 0:
            return
        tick = lua(f"local n=a.get_main_inventory().insert{{name='{item}',count={count}}}; rcon.print(helpers.table_to_json({{inserted=n,tick=game.tick}}))", f'seed {item}')
        require(tick['inserted'] == count, {'seed_failed': item, 'result': tick})
        evidence['seeded_raw_inputs'].append({'item': item, 'count': count, 'reason': reason, 'tick': tick['tick']})
        flush()

    def ensure_raw(item: str, needed: int, reason: str) -> None:
        seed_raw(item, needed - inventory_count(item), reason)

    def stats(item: str) -> dict:
        return lua(
            "local i,o=0,0; for _,sf in pairs(game.surfaces) do local st=f.get_item_production_statistics(sf); "
            f"i=i+st.get_input_count('{item}'); o=o+st.get_output_count('{item}') end "
            f"local ev=remote.call('autorio_tools','evaluate_condition',{{kind='items_produced',item_name='{item}',minimum=1}}); "
            f"rcon.print(helpers.table_to_json({{tick=game.tick,item='{item}',engine_input=i,engine_output=o,evaluator=ev,inventory=a.get_item_count('{item}')}}))",
            f'statistics {item}',
        )

    def tech_state(name: str) -> dict:
        unlocks = techs[name]['unlocks']
        unlock_lua = '{' + ','.join(f"'{u}'" for u in unlocks) + '}'
        return lua(
            f"local t=f.technologies['{name}']; local rec={{}}; for _,r in ipairs({unlock_lua}) do rec[r]=f.recipes[r].enabled end "
            "rcon.print(helpers.table_to_json({tick=game.tick,researched=t.researched,enabled=t.enabled,progress=t.saved_progress,"
            "recipes_enabled=rec}))",
            f'technology {name}',
        )

    def craft_by_hand(item: str, count: int, context: str) -> None:
        run_operation(remote_call('autorio_operations', 'craft_item', repr(item), str(count)), context, max(60.0, count * 10.0))

    def ensure_item_by_hand(item: str, count: int, context: str) -> None:
        have = inventory_count(item)
        if have >= count:
            return
        leaves: dict[str, int] = {}
        path: list[dict] = []
        expand_hand_craft(item, count - have, leaves, path)
        for leaf, amount in leaves.items():
            if smelting_recipe(leaf) is None:
                ensure_raw(leaf, amount, f'{context}: raw ingredient of {item}')
        craft_by_hand(item, count - have, f'{context}: hand craft {item}')

    # ---- smelting: a real placed, fuelled furnace the NPC supplies and empties --------------
    def furnace_state(unit_number: int) -> dict:
        return lua(
            f"local fur=nil; for _,e in pairs(s.find_entities_filtered{{name='{FURNACE}'}}) do if e.unit_number=={unit_number} then fur=e end end "
            "assert(fur, 'furnace missing'); local out={}; local src={}; local fuel={}; "
            "for _,e in ipairs(fur.get_output_inventory().get_contents()) do out[e.name]=e.count end "
            "for _,e in ipairs(fur.get_inventory(defines.inventory.furnace_source).get_contents()) do src[e.name]=e.count end "
            "for _,e in ipairs(fur.get_fuel_inventory().get_contents()) do fuel[e.name]=e.count end "
            "rcon.print(helpers.table_to_json({tick=game.tick,status=fur.status,products_finished=fur.products_finished,output=out,source=src,fuel=fuel}))",
            f'furnace {unit_number}',
        )

    def smelt(item: str, count: int, purpose: str, watch_tech: str | None = None) -> dict:
        """Smelt `count` of a smelting product. Returns a record of what happened."""
        recipe = smelting_recipe(item)
        require(recipe is not None, {'not_smelting_product': item})
        ingredient = recipe['ingredients'][0]
        require(len(recipe['ingredients']) == 1 and ingredient['type'] == 'item', recipe)
        per_craft = product_amount(recipe, item)
        crafts = math.ceil(count / per_craft)
        ore_needed = int(crafts * ingredient['amount'])
        facts = lua(
            f"local p=prototypes.entity['{FURNACE}']; rcon.print(helpers.table_to_json({{speed=p.get_crafting_speed(), usage=p.get_max_energy_usage(), fuel=prototypes.item['{FUEL_ITEM}'].fuel_value}}))",
            'furnace facts',
        )
        seconds = crafts * recipe['energy'] / facts['speed']
        # get_max_energy_usage is joules per tick; accept watts too so a unit surprise only over-fuels.
        watts = facts['usage'] * 60 if facts['usage'] < 10000 else facts['usage']
        fuel_needed = math.ceil(seconds * watts / facts['fuel']) + 1
        record: dict[str, Any] = {'item': item, 'count': count, 'purpose': purpose, 'ore': ingredient['name'], 'ore_needed': ore_needed,
                                  'fuel_needed': fuel_needed, 'expected_sim_seconds': seconds, 'furnace_facts': facts}
        ensure_item_by_hand(FURNACE, 1, f'smelt {item}')
        ensure_raw(ingredient['name'], ore_needed, f'ore for {count} {item} ({purpose})')
        ensure_raw(FUEL_ITEM, fuel_needed, f'fuel for {count} {item} ({purpose})')
        placed = run_operation(remote_call('autorio_operations', 'place_entity', repr(FURNACE)), f'place furnace for {item}', 20.0)
        receipt = last_result(placed)
        unit = receipt.get('placed_unit_number')
        require(receipt.get('completed') is True and isinstance(unit, int), {'placement': placed})
        record['furnace_unit_number'] = unit
        supply_items = "{{item_name='%s',count=%d},{item_name='%s',count=%d}}" % (ingredient['name'], ore_needed, FUEL_ITEM, fuel_needed)
        supplied = run_operation(remote_call('autorio_operations', 'supply_entity', str(unit), supply_items), f'supply furnace for {item}', 30.0)
        supply_result = last_result(supplied)
        require(supply_result.get('completed') is True and (supply_result.get('moved_count') or 0) > 0, {'supply': supplied})
        deadline_ticks = int(seconds * 60 * 2 + 1800)
        first_tick = clock()['tick']
        produced = 0
        trace: list[dict] = []
        record['progress_trace'] = trace
        while True:
            state = furnace_state(unit)
            produced = int(state['output'].get(item, 0))
            if watch_tech is not None:
                watched = tech_state(watch_tech)
                trace.append({'tick': watched['tick'], 'products_finished': state['products_finished'], 'in_furnace_output': produced, 'researched': watched['researched']})
                # The trigger must not complete before the item has actually been produced.
                require(not (watched['researched'] and state['products_finished'] < count), {'trigger_completed_before_production': trace[-1], 'count': count})
            if produced >= crafts * per_craft:
                break
            require(state['tick'] - first_tick <= deadline_ticks, {'message': 'furnace did not finish within twice its expected time', 'furnace': state, 'record': record})
            run_operation(remote_call('autorio_operations', 'wait', '300'), f'wait for furnace ({item})', 30.0)
        record['produced_in_furnace'] = produced
        record['finished_tick'] = state['tick']
        before = inventory_count(item)
        run_operation(remote_call('autorio_operations', 'move_items_exact', repr(item), str(unit), str(produced), 'false'), f'retrieve {item}', 30.0)
        retrieve = last_result(operation_status(f'retrieve receipt {item}'))
        require(retrieve.get('completed') is True and retrieve.get('moved_count') == produced, {'retrieve': retrieve})
        require(inventory_count(item) == before + produced, {'inventory_after_retrieve': inventory_count(item), 'before': before, 'produced': produced})
        record['retrieved'] = produced
        return record

    # ---- one trigger technology -----------------------------------------------------------------
    def drive_trigger(name: str, trigger: dict) -> dict:
        kind = trigger.get('type')
        result: dict[str, Any] = {'technology': name, 'trigger': trigger, 'type': kind}
        if kind != 'craft-item':
            raise Finding(f'FINDING trigger_type_unsupported_by_cell tech={name} type={kind} trigger={json.dumps(trigger, sort_keys=True)}')
        item = trigger_item_name(trigger)
        count = int(trigger.get('count') or 1)
        if isinstance(trigger.get('item'), dict) and trigger['item'].get('quality') not in (None, 'normal'):
            raise Finding(f'FINDING trigger_quality_unsupported_by_cell tech={name} item={json.dumps(trigger["item"], sort_keys=True)}')
        require(item is not None, trigger)
        result.update({'item': item, 'count': count})
        before_stats = stats(item)
        result['stats_before'] = before_stats
        action_start = clock()['tick']
        result['action_started_tick'] = action_start
        if smelting_recipe(item) is not None:
            result['route'] = 'smelt in placed furnace'
            result['smelting'] = smelt(item, count, f'trigger of {name}', name)
        else:
            result['route'] = 'native hand craft'
            leaves: dict[str, int] = {}
            path: list[dict] = []
            expand_hand_craft(item, count, leaves, path)
            result['hand_craft_expansion'] = {'leaves': leaves, 'path': path}
            for recipe in path:
                if not recipe['enabled_at_plan_time']:
                    raise Finding(f'FINDING recipe_locked_for_trigger tech={name} recipe={recipe["recipe"]}')
            shortfalls: dict[str, int] = {}
            for leaf, amount in leaves.items():
                have = inventory_count(leaf)
                if smelting_recipe(leaf) is not None and have < amount:
                    shortfalls[leaf] = amount - have
            result['plate_shortfalls_smelted_first'] = shortfalls
            result['supporting_smelts'] = [smelt(leaf, short, f'ingredient of {item} for {name}') for leaf, short in shortfalls.items()]
            for leaf, amount in leaves.items():
                if smelting_recipe(leaf) is None:
                    ensure_raw(leaf, amount, f'raw ingredient of trigger {item} for {name}')
            # The trigger itself: exactly `count` of the item, by the native crafting queue.
            before_item = inventory_count(item)
            craft_by_hand(item, count, f'trigger craft {item} x{count} for {name}')
            require(inventory_count(item) == before_item + count, {'inventory_after_craft': inventory_count(item), 'before': before_item, 'count': count})
        result['action_finished_tick'] = clock()['tick']
        deadline = time.monotonic() + POLL_AFTER_TRIGGER_SECONDS
        state = tech_state(name)
        while not state['researched'] and time.monotonic() < deadline:
            time.sleep(0.1)
            state = tech_state(name)
        result['after'] = state
        result['stats_after'] = stats(item)
        result['researched_observed_tick'] = state['tick'] if state['researched'] else None
        if not state['researched']:
            raise Finding(
                f"FINDING trigger_not_credited tech={name} type={kind} item={item} count={count} "
                f"produced={result['stats_after']['inventory']} stat={result['stats_after']['engine_input']} "
                f"evidence={json.dumps({'before': before_stats, 'after': result['stats_after']}, sort_keys=True)}"
            )
        disabled = [r for r, enabled in state['recipes_enabled'].items() if not enabled]
        if disabled:
            raise Finding(f'FINDING unlocked_recipes_not_enabled tech={name} recipes={disabled}')
        # Goal evaluation must count each produced item once.
        ev = result['stats_after']['evaluator']
        expected = ev['production_statistics'] + ev['hand_crafted'] - ev.get('hand_crafted_in_statistics', 0)
        result['evaluator_arithmetic'] = {'current': ev['current'], 'expected': expected}
        require(ev['current'] == expected, {'evaluator_inconsistent': ev})
        return result

    # ---- run the ladder -----------------------------------------------------------------------
    clock_start = clock()
    require(clock_start['connected'] == 0, clock_start)
    lua('remote.call("autorio_operations","cancel_all_tasks"); game.speed=' + str(GAME_SPEED) + '; rcon.print("{}")', 'fixture: cancel tasks + speed')
    evidence['game_speed'] = GAME_SPEED
    evidence['start_tick'] = clock_start['tick']
    try:
        for name in order:
            tech = techs[name]
            trigger = tech.get('research_trigger')
            if not trigger:
                evidence['lab_research_not_exercised'].append({
                    'technology': name, 'unit_count': tech.get('unit_count'), 'unit_ingredients': tech.get('unit_ingredients'),
                })
                continue
            missing = [p for p in tech['prerequisites'] if not tech_state(p)['researched']]
            if missing:
                raise Finding(f'FINDING prerequisite_unresearched tech={name} missing={missing} (lab research is not exercised by this cell)')
            outcome = drive_trigger(name, trigger)
            evidence['results'][name] = outcome
            print(f'[trigger-ladder] {name}: {trigger.get("type")} {trigger_item_name(trigger)} x{trigger.get("count", 1)} -> researched at tick {outcome["researched_observed_tick"]}', flush=True)
            flush()
    except Finding as finding:
        evidence['findings'].append(str(finding))
        flush()
        raise

    for name in order:
        if techs[name].get('research_trigger'):
            require(tech_state(name)['researched'] is True, {'not_researched_at_end': name})
    for lab in evidence['lab_research_not_exercised']:
        require(tech_state(lab['technology'])['researched'] is False, {'lab_tech_unexpectedly_researched': lab})
    evidence['status'] = 'pass'
    evidence['end_tick'] = clock()['tick']
    flush()
    triggers = ', '.join(f"{n}@{evidence['results'][n]['researched_observed_tick']}" for n in order if n in evidence['results'])
    print(f"PASS: zero-player NPC completed every trigger technology in the closure from a fresh world: {triggers}; "
          f"lab techs not exercised: {[x['technology'] for x in evidence['lab_research_not_exercised']]}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', type=Path, required=True)
    args = parser.parse_args()
    client = None
    try:
        client = connect_with_retry(args.host, args.port, args.password)
        run(client, args.results)
        return 0
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / 'trigger-ladder-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        try:
            if client:
                client.command('/silent-command game.speed=1')
        except Exception:
            pass
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
