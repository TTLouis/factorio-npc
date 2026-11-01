#!/usr/bin/env python3
"""Native NPC lab craft must unlock red science; prerequisite seeding is fixture-only."""
import argparse
import json
import time
from pathlib import Path
from run import connect_with_retry, decode_json
from runtime import operation_status_command, wait_until_idle


def run(client, results):
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript = []
    def command(lua):
        reply = client.command('/silent-command ' + lua)
        transcript.append({'lua': lua, 'reply': reply})
        return decode_json(reply, 'craft trigger cell')
    prefix = f'local s=game.surfaces[1];local a=game.get_entity_by_unit_number({actor_id});assert(a and a.valid);local f=a.force;'
    def observe():
        return command(prefix + 'rcon.print(helpers.table_to_json({humans=#game.connected_players,actor_id=a.unit_number,red=f.technologies["automation-science-pack"].researched,enabled=f.recipes["automation-science-pack"].enabled,lab=a.get_main_inventory().get_item_count("lab"),stat=f.get_item_production_statistics(s).get_input_count("lab"),goal=remote.call("autorio_tools","evaluate_condition",{kind="items_produced",item_name="lab",minimum=1}),craft=remote.call("autorio_crafting","status")}))')
    # Only prerequisites and ingredients are seeded. Target technology stays locked.
    command(prefix + 'remote.call("autorio_operations","cancel_all_tasks");f.technologies["steam-power"].researched=true;f.technologies.electronics.researched=true;assert(not f.technologies["automation-science-pack"].researched);a.get_main_inventory().clear();a.get_main_inventory().insert{name="iron-plate",count=80};a.get_main_inventory().insert{name="copper-plate",count=40};game.speed=1;rcon.print("{}")')
    before = observe()
    assert before['humans'] == 0 and not before['red'] and not before['enabled'], before
    def craft():
        admission = command('local r=remote.call("autorio_operations","craft_item","lab",1);rcon.print(helpers.table_to_json({accepted=r[1]}))')
        assert admission['accepted'], admission
        wait_until_idle(lambda _: decode_json(client.command(operation_status_command()), 'craft status'), 'native lab craft', 60)
    craft()
    deadline = time.monotonic() + 10
    after = observe()
    while not after['red'] and time.monotonic() < deadline:
        time.sleep(.1)
        after = observe()
    assert after['lab'] == before['lab'] + 1 and after['stat'] == before['stat'] + 1, after
    assert after['red'] and after['enabled'], after
    assert after['goal']['current'] == before['goal']['current'] + 1, after
    assert after['craft']['last_result']['completed'], after
    # A second completed lab is counted by the mod, but no longer needs trigger flow.
    craft()
    second = observe()
    assert second['lab'] == after['lab'] + 1 and second['stat'] == after['stat'], second
    assert second['goal']['current'] == after['goal']['current'] + 1, second
    (results / 'craft-trigger-cell.json').write_text(json.dumps({'status':'pass','actor_id':actor_id,'fixture':'seeded prerequisites and ingredients only','before':before,'after':after,'second':second,'transcript':transcript}, indent=2))
    print('PASS: native lab crafting unlocks red research and goal counts remain exact', flush=True)


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--host', required=True);p.add_argument('--port',type=int,required=True);p.add_argument('--password',required=True);p.add_argument('--results',type=Path,required=True)
    args=p.parse_args();client=None
    try:
        client=connect_with_retry(args.host,args.port,args.password);run(client,args.results);return 0
    except Exception as exc:
        (args.results/'craft-trigger-cell-error.txt').write_text(str(exc));raise
    finally:
        if client: client.close()

if __name__=='__main__': raise SystemExit(main())