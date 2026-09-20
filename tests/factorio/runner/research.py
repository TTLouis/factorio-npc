"""Research submission is not completion: prove native lab work separately."""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, lua_text, remote_call
from runtime import operation_status_command, validate_clock, wait_until_idle


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def assert_actor(observation: dict, actor_id: int) -> None:
    validate_clock(observation['runtime'])
    actor = observation['actor']
    require(actor['valid'] is True and actor['kind'] == 'standalone_character', observation)
    require(actor['actor_id'] == actor_id, observation)
    require(observation['walking'] is False and observation['mining'] is False, observation)
    require(observation['shooting'] is False, observation)


def assert_completed(before: dict, after: dict, actor_id: int) -> None:
    assert_actor(after, actor_id)
    require(before['researched'] is False, 'fixture must not begin with completed target research')
    require(after['researched'] is True, 'an accepted request or an idle NPC is not completed research')
    require(before['unlocked'] is False, 'fixture must not pre-unlock the target recipe')
    require(before['required_science'] > 0 and len(before['lab_ids']) == 4, before)
    require(after['force_index'] == before['force_index'], 'actor changed force')
    require(after['unlocked'] is True, 'expected assembling-machine-1 recipe was not unlocked')
    require(after['science'] == 0 and before['science'] == before['required_science'], (before, after))
    require(after['lab_ids'] == before['lab_ids'], 'fixture labs disappeared or were replaced')
    require(after['runtime']['tick'] > before['runtime']['tick'], 'no engine time passed')
    require(after['task_state'] == 'idle' and after['queue_empty'] is True and after['queue_length'] == 0, after)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    transcript = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'research-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def research_status() -> dict:
        return json_command(lua_json(remote_call('autorio_research', 'status')), 'research status')

    def technology(name: str) -> dict:
        return json_command(lua_json(remote_call('autorio_research', 'technology', repr(name))), 'technology observation')

    def submit(name: str, expected: bool, reason: str | None = None) -> list:
        result = json_command(lua_json(remote_call('autorio_operations', 'research_technology', repr(name))), 'research submission')
        require(result[0] is expected, result)
        if reason is not None:
            require(result[1] == reason, result)
        return result

    def preflight(name: str) -> dict:
        command_text = (
            "/silent-command rcon.print(helpers.table_to_json(remote.call('autorio_preflight','operation',"
            "'research_technology',{technology_name=" + repr(name) + "})))"
        )
        return json_command(command_text, 'research preflight')

    original_id = json.loads((results / 'runner.json').read_text())['actor_id']
    initial = status('before research')
    require(initial['actor']['actor_id'] == original_id and initial['actor']['valid'] is True, initial)
    validate_clock(initial['runtime'])
    require(initial['task_state'] == 'idle' and initial['queue_length'] == 0, initial)

    # Check real early-game deterministic preflight before any mutation admission.
    # The same locked target is then submitted directly below to preserve the
    # engine-backed assertion that real Autorio admission still rejects it.
    unknown_preflight = preflight('__airi_missing_technology__')
    trigger_preflight = preflight('steam-power')
    locked_preflight = preflight('automation')
    require(unknown_preflight['ok'] is False and unknown_preflight['code'] == 'unknown_technology', unknown_preflight)
    require(trigger_preflight['ok'] is False and trigger_preflight['code'] == 'trigger_research', trigger_preflight)
    require(locked_preflight['ok'] is False and locked_preflight['code'] == 'missing_prerequisites', locked_preflight)
    next_actionable = locked_preflight.get('next_actionable')
    require(isinstance(next_actionable, dict) and next_actionable.get('name') and next_actionable.get('name') != 'automation', locked_preflight)
    trigger_observation = technology('steam-power')
    require(trigger_preflight.get('research_trigger') == trigger_observation.get('research_trigger'), (trigger_preflight, trigger_observation))
    untouched_research = research_status()
    require(untouched_research.get('current') is None and untouched_research.get('queue_length', 0) == 0, untouched_research)

    # Check real early-game rejection BEFORE setting up this isolated research
    # fixture. The success target (automation) is never directly researched.
    submit('__airi_missing_technology__', False, 'unknown_technology')
    submit('steam-power', False, 'trigger_research')
    submit('automation', False, 'missing_prerequisites')
    require(technology('__airi_missing_technology__')['found'] is False, 'unknown technology appeared')
    trigger = technology('steam-power')
    require(trigger['found'] is True and trigger['trigger_type'] == 'craft-item', trigger)
    require(trigger['request_error'] == 'trigger_research', trigger)
    locked = technology('automation')
    require(locked['researched'] is False and locked['request_error'] == 'missing_prerequisites', locked)

    fixture = json_command(
        "/silent-command "
        "local f=game.forces.player; local s=game.surfaces[1]; "
        "local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'original NPC missing'); "
        "local t=f.technologies.automation; assert(t and not t.researched,'automation already researched'); "
        "assert(f.current_research==nil and #f.research_queue==0,'fixture would overwrite research'); "
        "local seeded={}; for _,n in ipairs({'steam-power','electronics','automation-science-pack'}) do "
        "local p=f.technologies[n]; assert(p,'missing prerequisite'); "
        "if not p.researched then p.researched=true; seeded[#seeded+1]=n end end; "
        "assert(not t.researched,'fixture completed target'); "
        "assert(#t.research_unit_ingredients==1 and t.research_unit_ingredients[1].name=='automation-science-pack'); "
        "assert(t.research_unit_ingredients[1].amount==1 and t.research_unit_count>=4 and t.research_unit_count<=100); "
        "assert(f.laboratory_speed_modifier==0 and f.laboratory_productivity_bonus==0,'unexpected research modifiers'); "
        "local p=a.position; local tiles={}; "
        "for x=math.floor(p.x)-16,math.floor(p.x)+16 do for y=math.floor(p.y)-16,math.floor(p.y)+16 do "
        "tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; s.set_tiles(tiles,true,false,true); "
        "for _,e in pairs(s.find_entities_filtered{position=p,radius=16}) do if e.type~='character' then e.destroy() end end; "
        "local ids={}; for _,x in ipairs({4,8}) do for _,y in ipairs({-5,-1}) do "
        "local l=s.create_entity{name='lab',position={x=p.x+x,y=p.y+y},force=f}; assert(l,'lab fixture failed'); "
        "ids[#ids+1]=l.unit_number end end; table.sort(ids); "
        "assert(s.create_entity{name='substation',position={x=p.x+6,y=p.y+2},force=f}); "
        "local power=s.create_entity{name='electric-energy-interface',position={x=p.x+10,y=p.y+2},force=f}; assert(power); "
        "power.electric_buffer_size=10000000; power.power_production=1000000; power.power_usage=0; power.energy=10000000; "
        "rcon.print(helpers.table_to_json({prerequisites_seeded=seeded,lab_ids=ids,required_science=t.research_unit_count,"
        "researched=t.researched,unlocked=f.recipes['assembling-machine-1'].enabled}))",
        'research fixture',
    )
    require(fixture['researched'] is False and fixture['unlocked'] is False, fixture)

    observation_command = (
        "/silent-command local s=game.surfaces[1]; local f=game.forces.player; "
        "local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'original NPC missing'); "
        "local o=remote.call('autorio_operations','status'); local t=f.technologies.automation; "
        "local ids={}; local science=0; for _,l in pairs(s.find_entities_filtered{name='lab',position=a.position,radius=16,force=f}) do "
        "ids[#ids+1]=l.unit_number; science=science+l.get_item_count('automation-science-pack') end; table.sort(ids); "
        "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
        "o.force_index=a.force.index; o.researched=t.researched; o.unlocked=f.recipes['assembling-machine-1'].enabled; "
        "o.current=f.current_research and f.current_research.name or nil; "
        "o.progress=f.current_research and f.research_progress or 0; "
        "o.science=science; o.required_science=t.research_unit_count; o.lab_ids=ids; "
        "o.walking=a.walking_state.walking; o.mining=a.mining_state.mining; "
        "o.shooting=a.shooting_state.state~=defines.shooting.not_shooting; "
        "rcon.print(helpers.table_to_json(o))"
    )

    def observe() -> dict:
        result = json_command(observation_command, 'research observation')
        assert_actor(result, original_id)
        return result

    command('/silent-command game.forces.player.disable_research(); rcon.print("disabled")')
    submit('automation', False, 'research_disabled')
    command('/silent-command game.forces.player.enable_research(); game.forces.player.technologies.automation.enabled=false; rcon.print("disabled technology")')
    submit('automation', False, 'technology_disabled')
    command('/silent-command game.forces.player.technologies.automation.enabled=true; rcon.print("restored")')

    # Atomic setup proves that admission does not start force research early.
    deferred_command = (
        "/silent-command remote.call('autorio_operations','wait',180); "
        "local accepted=remote.call('autorio_operations','research_technology','automation'); "
        "local o=remote.call('autorio_operations','status'); "
        "o.accepted=accepted[1]; o.research_active=game.forces.player.current_research~=nil; "
        "rcon.print(helpers.table_to_json(o))"
    )
    deferred = json_command(deferred_command, 'pending research admission')
    require(deferred['accepted'] is True and deferred['research_active'] is False, deferred)
    require(deferred['task_state'] == 'waiting' and deferred['queue_length'] == 1, deferred)
    require(command(lua_text(remote_call('autorio_operations', 'cancel_all_tasks'))) == 'true', "Research assertion failed: command(lua_text(remote_call('autorio_operations', 'cancel_all_tasks'))) == 'true'")
    time.sleep(2)
    cancelled = observe()
    require(cancelled.get('current') is None and cancelled['researched'] is False, cancelled)

    deferred = json_command(deferred_command, 'retry research admission')
    require(deferred['research_active'] is False, deferred)
    wait_until_idle(status, 'research request dispatch', 10)
    pending = observe()
    require(pending['researched'] is False and pending['current'] == 'automation', pending)
    require(pending['science'] == 0, pending)
    accepted = research_status()['last_request_result']
    require(accepted['accepted'] is True and accepted['code'] == 'started', accepted)

    submit('automation', True)
    wait_until_idle(status, 'duplicate research request', 5)
    duplicate = research_status()
    require(duplicate['last_request_result']['code'] == 'already_queued', duplicate)
    require(duplicate['queue_length'] == 1, duplicate)
    submit('electric-mining-drill', False, 'force_busy')
    require(research_status()['current']['name'] == 'automation', "Research assertion failed: research_status()['current']['name'] == 'automation'")
    require(command(lua_text(remote_call('autorio_operations', 'cancel_all_tasks'))) == 'true', "Research assertion failed: command(lua_text(remote_call('autorio_operations', 'cancel_all_tasks'))) == 'true'")
    require(research_status()['current']['name'] == 'automation', 'NPC cancellation cancelled shared research')

    # Seed real science into four normal labs. No research_progress, target
    # researched flag, lab speed, productivity, or game speed is modified.
    supplied = json_command(
        "/silent-command local s=game.surfaces[1]; local f=game.forces.player; "
        "local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a); "
        "local labs=s.find_entities_filtered{name='lab',position=a.position,radius=16,force=f}; "
        "assert(#labs==4); table.sort(labs,function(a,b) return a.unit_number<b.unit_number end); "
        "local total=f.technologies.automation.research_unit_count; local inserted=0; "
        "for i,l in ipairs(labs) do local count=math.floor(total/#labs)+(i<=total%#labs and 1 or 0); "
        "inserted=inserted+l.get_inventory(defines.inventory.lab_input).insert{name='automation-science-pack',count=count} end; "
        "rcon.print(helpers.table_to_json({inserted=inserted,required_science=total,tick=game.tick}))",
        'science fixture',
    )
    require(supplied['inserted'] == supplied['required_science'], supplied)
    before = observe()
    # The seed command captures the exact inserted count before the next tick.
    # Inventory counts may already change by the first observation, so retain
    # the atomic insertion value rather than assuming RCON observations freeze time.
    before['science'] = supplied['inserted']
    before['runtime']['tick'] = supplied['tick']
    require(before['researched'] is False, before)

    result = json_command(lua_json(remote_call('autorio_operations', 'wait', '120')), 'work during research')
    require(result[0] is True, result)
    wait_until_idle(status, 'NPC work while labs research', 5)
    working = observe()
    require(working['researched'] is False and working['progress'] > 0, working)

    wall_start = time.monotonic()
    start_tick = working['runtime']['tick']
    previous_tick = start_tick
    last_advance = wall_start
    last_report = wall_start
    while True:
        after = observe()
        now = time.monotonic()
        tick = after['runtime']['tick']
        require(tick >= previous_tick, 'research simulation tick rewound')
        if tick > previous_tick:
            last_advance = now
        previous_tick = tick
        require(tick - start_tick < 7200 and now - wall_start < 120, f'research completion budget exhausted: {after!r}')
        require(now - last_advance < 10, f'research simulation clock stopped: {after!r}')
        if after['researched']:
            break
        require(after.get('current') == 'automation', f'research was interrupted: {after!r}')
        if now - last_report >= 5:
            print(f'[npc-test] native research progress={after["progress"]:.3f}, remaining science={after["science"]}', flush=True)
            last_report = now
        time.sleep(0.25)

    assert_completed(before, after, original_id)
    completed_technology = technology('automation')
    require(completed_technology['found'] is True and completed_technology['researched'] is True, completed_technology)
    submit('automation', True)
    wait_until_idle(status, 'already completed research request', 5)
    require(research_status()['last_request_result']['code'] == 'already_researched', "Research assertion failed: research_status()['last_request_result']['code'] == 'already_researched'")
    final = observe()
    assert_completed(before, final, original_id)
    (results / 'research.json').write_text(json.dumps({
        'status': 'pass', 'actor_id': original_id, 'fixture': fixture,
        'before': before, 'after': final, 'pending': pending,
    }, indent=2))
    print(f'PASS: zero-player NPC research submission + native lab completion with stable actor_id={original_id}', flush=True)


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
        (args.results / 'research-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
