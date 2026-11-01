"""A1 test-only steam -> lab proof; never import into model-facing context.

Called after steam_power_cell's unchanged drill measurements. Fixture setup
seeds a lab, pole, science and prerequisite technologies, never the target.
All construction, science transfer and research submission use NPC operations.
The only subsequent world-setting change is restoring speed 1 for this gate.
"""
import json

from run import remote_call


def require(condition, details):
    if not condition:
        raise AssertionError(details)


def assert_progress(before, after):
    """Reject placement/admission-only success and unrelated or fake power."""
    for sample in (before, after):
        require(sample['humans'] == 0 and sample['speed'] == 1, sample)
        require(sample['actor_valid'] and sample['actor_kind'] == 'standalone_character', sample)
        require(sample['current'] == 'automation' and not sample['researched'], sample)
        require(sample['lab_status'] == 'working' and sample['lab_energy'] > 0, sample)
        require(sample['lab_network'] == sample['engine_network'] and sample['lab_network'] > 0, sample)
        require(sample['engine_generating'] > 0 and sample['steam'] > 0, sample)
        require(sample['lab_count'] == 1 and sample['artificial_power_count'] == 0, sample)
    require(after['actor_id'] == before['actor_id'] and after['lab_id'] == before['lab_id'], (before, after))
    require(after['tick'] - before['tick'] >= 300, (before, after))
    require(after['progress'] > before['progress'] > 0, (before, after))
    require(after['science'] < 10 and after['science'] <= before['science'], (before, after))


def run_powered_lab_chain(json_command, run_operation, wait_ticks, evaluate,
                          find_actor, actor_id, boiler_unit, engine_unit, pole, results):
    evidence = {'status': 'fail', 'rung': 'A1', 'actor_id': actor_id,
                'target': 'automation', 'science_seeded': 10, 'receipts': []}

    def flush():
        (results / 'powered-lab-chain.json').write_text(json.dumps(evidence, indent=2))

    def operate(name, *args):
        receipt = run_operation(remote_call('autorio_operations', name, *args), name, 40.0)
        evidence['receipts'].append({'operation': name, 'receipt': receipt})
        flush()
        return receipt

    flush()
    json_command('/silent-command game.speed=1; rcon.print(helpers.table_to_json({speed=game.speed}))', 'lab speed 1')
    operate('supply_entity', str(boiler_unit), "{{item_name='coal',count=10}}")
    # Six tiles south of the existing middle pole leaves a 3x3 lab outside
    # every current pole's supply area. A new pole later bridges that gap.
    lab = operate('place_entity', repr('lab'), str(pole['x']), str(pole['y'] + 6))
    lab_id = lab['placed_unit_number']
    require(isinstance(lab_id, int), lab)
    operate('supply_entity', str(lab_id), "{{item_name='automation-science-pack',count=10}}")
    # Research has a dedicated receipt; task-idle/accepted is not completion.
    submitted = json_command(
        '/silent-command local r=' + remote_call('autorio_operations', 'research_technology', "'automation'") +
        '; rcon.print(helpers.table_to_json(r))', 'start automation')
    require(submitted[0] is True, submitted)
    evidence['submission'] = submitted
    wait_ticks(300, 'unpowered research negative window')

    probe = (
        '/silent-command ' + find_actor +
        "local l=nil; local e=nil; for _,entity in pairs(s.find_entities_filtered{name={'lab','steam-engine'},force=a.force}) do "
        f"if entity.unit_number=={lab_id} then l=entity elseif entity.unit_number=={engine_unit} then e=entity end end; assert(l and e); "
        "local f=a.force; local st=remote.call('autorio_operations','status'); "
        "local status=nil; for k,v in pairs(defines.entity_status) do if v==l.status then status=k end end; "
        "local steam=e.fluidbox[1]; "
        "rcon.print(helpers.table_to_json({tick=game.tick,speed=game.speed,humans=#game.connected_players,"
        "actor_id=st.actor.actor_id,actor_valid=st.actor.valid,actor_kind=st.actor.kind,lab_id=l.unit_number,"
        "current=f.current_research and f.current_research.name,progress=f.current_research and f.research_progress or 0,"
        "researched=f.technologies.automation.researched,science=l.get_item_count('automation-science-pack'),"
        "lab_status=status,lab_energy=l.energy,lab_network=l.electric_network_id or 0,engine_network=e.electric_network_id or 0,"
        "engine_generating=e.energy_generated_last_tick,steam=steam and steam.amount or 0,"
        "lab_count=s.count_entities_filtered{name='lab',force=f},"
        "artificial_power_count=s.count_entities_filtered{type={'electric-energy-interface','solar-panel','accumulator'},force=f}}))"
    )
    unpowered = json_command(probe, 'unpowered lab observation')
    evidence['unpowered'] = unpowered
    flush()
    require(unpowered['current'] == 'automation' and unpowered['progress'] == 0
            and not unpowered['researched'] and unpowered['science'] == 10
            and unpowered['lab_energy'] == 0, unpowered)
    print('PASS: LAB_UNPOWERED - placed, supplied, research admitted; zero native progress without power', flush=True)

    operate('place_entity', repr('small-electric-pole'), str(pole['x'] + 2), str(pole['y'] + 3))
    wait_ticks(300, 'steam powered lab first window')
    before = json_command(probe, 'powered research first sample')
    wait_ticks(300, 'steam powered lab second window')
    after = json_command(probe, 'powered research second sample')
    powered = evaluate("{kind='electric_network_satisfied',entity_name='lab',minimum=1}", 'powered lab goal')
    evidence.update({'before': before, 'after': after, 'power_condition': powered})
    flush()
    assert_progress(before, after)
    require(before['actor_id'] == actor_id, before)
    require(powered['satisfied'] is True and powered['current'] == 1
            and powered['producers'] == ['steam-engine'], powered)
    evidence['status'] = 'pass'
    flush()
    print(f"PASS: LAB_RESEARCH - same actor/lab, zero humans, speed 1, sole steam producer; "
          f"research {before['progress']:.6f} -> {after['progress']:.6f}, "
          f"science remaining {after['science']}/10", flush=True)
    return evidence
