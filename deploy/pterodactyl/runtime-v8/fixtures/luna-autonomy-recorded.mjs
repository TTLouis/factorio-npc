// Recorded autonomy regression fixture (repair unit E).
//
// The model replies, tool outputs, world snapshots and receipts below were extracted from the retained CLI-proxy
// red-to-green run of 2026-10-05 (the four failures analysed in docs/validation/LUNA_AUTONOMY_FAILURE_ANALYSIS_2026-10-05.md).
// The `provenance` object maps every entry to its retained request id and turn, says whether it is a verbatim message or
// reconstructed from a behavior event, and lists what was trimmed. Values are trimmed to what the model was shown; output
// sizes are kept (the lab recipe read is several kilobytes) so toy fixtures cannot hide a live-size bug.
//
// No provider names, hosts, tailnet names, URLs or credentials appear here; the retained world-snapshot file that does
// carry an infrastructure hostname was deliberately not used.
export default {
 "provenance": {
  "source": "Retained CLI-proxy red-to-green run of 2026-10-05 (git-ignored test-results/luna-red-green-2026-10-05/data/logs: sgluna-behavior.jsonl, sgluna-prompts.jsonl).",
  "requests": {
   "req_muw0mkcw_1": "first request (new goal, planner role, turns 1-8; ended blocked_no_operation after item_missing)",
   "req_muw0tw25_2": "second request (operator amendment; ended blocked_no_operation after item_missing)",
   "req_muw0yzan_3": "third request (operator amendment; eleven 600-tick waits, then nothing_moved)",
   "req_muw17okc_4": "fourth request (operator amendment; ended provider_action_omission_repair_failed)"
  },
  "replies": {
   "req_muw0yzan_3.turn1.planner_commit": "req_muw0yzan_3 turn 1, planner: verbatim assistant message (read back from the next request of the same context)",
   "req_muw0yzan_3.turn2.executor_wait": "req_muw0yzan_3 turn 2 (repeated verbatim on turns 3-11), executor: verbatim assistant message",
   "req_muw0yzan_3.turn12.collect_with_checkpoint_change": "req_muw0yzan_3 turn 12, planner/executor: verbatim assistant message (move_items_exact of the furnace plates plus a replacement held-inventory checkpoint)",
   "req_muw0yzan_3.turn13.copper_load": "req_muw0yzan_3 turn 13: verbatim assistant message",
   "req_muw0mkcw_1.turn7.craft_plates_by_hand": "req_muw0mkcw_1 turn 7 round 0 (also turns 3 and 4 with the same craft_item iron-plate): verbatim assistant message",
   "req_muw0mkcw_1.turn7.supply_coal_not_held": "req_muw0mkcw_1 turn 7 round 2: verbatim assistant message (supply_entity coal 10 while the NPC held no coal)",
   "req_muw0tw25_2.turn1.planner_commit": "req_muw0tw25_2 turn 1, planner: reconstructed from the plan.accepted behavior event (chat, plan, step, operations without trace ids, checkpoint); the raw tool-call arguments are not retained",
   "req_muw0tw25_2.turn2.load_coal": "req_muw0tw25_2 turn 2, executor: verbatim assistant message",
   "req_muw0tw25_2.turn3.load_ore_already_loaded": "req_muw0tw25_2 turn 3, executor: verbatim assistant message (move_items_exact iron-ore into furnace 15 while the furnace already held 50 and the NPC held none)",
   "req_muw17okc_4.turn1.planner_commit": "req_muw17okc_4 turn 1, planner: reconstructed from the plan.accepted behavior event (see req_muw0tw25_2.turn1)",
   "req_muw17okc_4.turn2.executor_zero_operations": "req_muw17okc_4 turn 2, fresh executor: verbatim assistant message (remaining plan, zero operations)",
   "req_muw17okc_4.turn2.repair_zero_operations": "req_muw17okc_4 turn 2, bounded act-or-block repair: reconstructed from the plan.accepted behavior event (zero operations again)"
  },
  "worldReads": {
   "recipeLab": "req_muw17okc_4 turn 1 round 0, getRecipeDetails lab: verbatim tool output",
   "recipeCopperPlate": "req_muw17okc_4 turn 1 round 1, getRecipeDetails copper-plate x10: verbatim tool output",
   "recipeIronPlate": "req_muw0mkcw_1 turn 2, getRecipeDetails iron-plate x42 with coal: verbatim tool output",
   "technologyElectronics": "req_muw17okc_4 turn 1 round 0, getTechnology electronics: verbatim tool output",
   "technologyAutomationScience": "req_muw17okc_4 turn 1 round 1, getTechnology automation-science-pack: verbatim tool output",
   "inventoryReq1Turn7": "req_muw0mkcw_1 turn 7 round 1, getInventoryItems: verbatim tool output (burner-mining-drill 1, copper-ore 10, iron-plate 8)",
   "inventoryReq4": "req_muw17okc_4 turn 1 round 0, getInventoryItems: verbatim tool output (burner-mining-drill 1, iron-plate 58)",
   "furnaceOre50NoFuel": "req_muw0tw25_2 turn 3, ENTITY_STATUS_BASELINE entity for unit 15 (50 iron-ore, no fuel), wrapper keys reference/query removed",
   "furnace47Plates": "req_muw0yzan_3 turn 1, ENTITY_STATUS_BASELINE entity for unit 15 (47 iron-plate, 2 iron-ore, 26 coal, working), wrapper keys removed",
   "furnaceCopper10": "req_muw17okc_4 turn 1 round 1, getEntityStatus unit 15 (10 copper-plate, 25 coal, status 18), wrapper keys removed",
   "nearbyFurnaceReq4": "req_muw17okc_4 turn 1 round 0, getNearbyEntities stone-furnace: tool output with wrapper keys removed",
   "actorStatusReq4": "req_muw17okc_4 turn 1 round 1, getActorStatus: verbatim tool output"
  },
  "receipts": {
   "req_muw0tw25_2.turn3.item_missing": "req_muw0tw25_2 turn 3 error continuation: verbatim [MOD] receipt text"
  },
  "requestText": "verbatim request.received text of each request (the operator amendments carry no hostnames or credentials)",
  "trimmed": [
   "Only the model reply, the world reads it was shown and the receipts are kept; system prompts, skill cards, steering, compat-state and requirements messages are omitted.",
   "Tool outputs are verbatim except where noted; the runtime adds observation_mode/source/query/reference around getEntityStatus and getNearbyEntities, so those wrapper keys are removed to give the raw mod shape.",
   "Replies marked reconstructed come from the plan.accepted behavior event, whose fields (chat, plan, step, operations, checkpoint) are the same ones the runtime parses; roadmap and time-review fields are dropped.",
   "req_muw17okc_4 turn 2 was the failing turn: the retained log has no next-action reply for it, so the repaired-path executor reply in the tests is scripted, not recorded."
  ]
 },
 "requestText": {
  "req_muw0mkcw_1": "New goal: Produce and use red science to research logistic-science-pack and unlock green science. Hand crafting and hand-fed machines are allowed; automation is not required. Use natural resources and native research. Work in small steps: smelt 50 iron plates and 10 copper plates, hand-craft a lab to unlock red science, supply steam power to the lab, then hand-craft and research with 75 red packs. Finish when logistic-science-pack is researched and its recipe is enabled.",
  "req_muw0tw25_2": "Revise the current plan and continue the same red-to-green goal. Gather 30 coal from natural deposits first, then fuel the existing stone furnace number 15, which already contains 50 iron ore. Missing carried coal is a recoverable supply dependency; gathering it still serves the current smelting step. Plates cannot be hand-crafted: use the furnace, wait for native smelting, collect the plates, then smelt the copper ore in that furnace. Keep the remaining lab, steam power and 75-red-pack research steps. You may gather any other missing ordinary ingredients and adjust your own structures to achieve this same goal.",
  "req_muw0yzan_3": "Revise the current plan and continue the same red-to-green goal. The native furnace at (19,55), unit 15, is actively smelting: at tick 38136 it had 35 iron plates in output, 14 iron ore in input and 27 coal in fuel. The missing carried ore is expected because you already loaded it. Do not supply iron ore again. Wait for 50 plates and the steam-power trigger, collect those 50 plates from the furnace, then load the carried 10 copper ore and wait for 10 copper plates and electronics. A running furnace is normal progress, not a structural blocker. Use live furnace observations and native crafting times to choose waits. Keep the lab, steam power and 75-red-pack research steps; collect any missing ordinary ingredients as needed.",
  "req_muw17okc_4": "Revise and resume the same red-to-green goal after the continuation pause. Your inventory now contains 58 iron plates: the 50 finished plates were successfully collected, so do not collect iron from the furnace again. Read the current furnace output and take its 10 copper plates. Steam-power is researched; the copper smelting should unlock electronics. Then gather and smelt whatever extra copper plates the live lab recipe needs and hand-craft one lab to unlock red science. Use live recipe and research facts; every wait must be followed by a fresh machine observation, not a repeat of an old transfer or old wait. The goal remains researching logistic-science-pack with naturally produced red packs."
 },
 "replies": {
  "req_muw0yzan_3.turn1.planner_commit": {
   "chatMessage": "The live furnace has 47 iron plates and is still working. I’ll let it finish the requested iron run, then collect the plates; I will not load iron ore again.",
   "plan": [
    "Gather 30 coal from natural deposits",
    "Fuel the existing stone furnace with 50 iron ore loaded, smelt and collect 50 iron plates",
    "Smelt and collect 10 copper plates in the furnace",
    "Craft a lab and complete the automation-science trigger",
    "Supply steam power to the lab",
    "Hand-craft and research with 75 red science packs"
   ],
   "currentStep": 1,
   "operations": [
    {
     "name": "wait",
     "args": {
      "ticks": 600
     }
    }
   ],
   "checkpoint": {
    "mode": "all",
    "requirements": [
     {
      "id": "requirement_1",
      "kind": "entity_inventory_count",
      "unit_number": 15,
      "item_name": "iron-plate",
      "minimum": 50
     }
    ],
    "confidence": 0,
    "source": "planner_semantic_checkpoint"
   },
   "roadmapNodeIds": [
    "triggers"
   ],
   "developmentMode": "vertical",
   "timeReview": {
    "decision": "keep_serial",
    "reason": "The running furnace is actively progressing on the current dependency; wait for its measured output rather than changing the production route."
   }
  },
  "req_muw0yzan_3.turn2.executor_wait": {
   "chatMessage": "",
   "plan": [
    "Fuel the existing stone furnace with 50 iron ore loaded, smelt and collect 50 iron plates",
    "Smelt and collect 10 copper plates in the furnace",
    "Craft a lab and complete the automation-science trigger",
    "Supply steam power to the lab",
    "Hand-craft and research with 75 red science packs"
   ],
   "currentStep": 0,
   "operations": [
    {
     "name": "wait",
     "args": {
      "ticks": 600
     }
    }
   ],
   "checkpoint": {
    "mode": "all",
    "requirements": [
     {
      "id": "requirement_1",
      "kind": "entity_inventory_count",
      "unit_number": 15,
      "item_name": "iron-plate",
      "minimum": 50
     }
    ],
    "confidence": 0,
    "source": "planner_semantic_checkpoint"
   }
  },
  "req_muw0yzan_3.turn12.collect_with_checkpoint_change": {
   "chatMessage": "",
   "plan": [
    "Gather 30 coal from natural deposits",
    "Smelt and collect 50 iron plates from the existing furnace; do not reload iron ore",
    "Smelt and collect 10 copper plates in the furnace",
    "Craft a lab and complete the automation-science trigger",
    "Supply steam power to the lab",
    "Hand-craft and research with 75 red science packs"
   ],
   "currentStep": 1,
   "operations": [
    {
     "name": "move_items_exact",
     "args": {
      "item_name": "iron-plate",
      "unit_number": 15,
      "max_count": 50,
      "to_entity": false
     }
    }
   ],
   "checkpoint": {
    "mode": "all",
    "requirements": [
     {
      "id": "requirement_1",
      "kind": "inventory_count",
      "item_name": "iron-plate",
      "minimum": 50
     }
    ],
    "confidence": 0,
    "source": "planner_semantic_checkpoint"
   },
   "roadmapNodeIds": [
    "triggers"
   ],
   "developmentMode": "vertical",
   "timeReview": {
    "decision": "parallelize",
    "reason": "The furnace run has exceeded the harness estimate and human steering says the output is ready; collect plates now rather than waiting again."
   }
  },
  "req_muw0yzan_3.turn13.copper_load": {
   "chatMessage": "",
   "plan": [
    "Gather 30 coal from natural deposits",
    "Fuel the existing stone furnace with 50 iron ore loaded, smelt and collect 50 iron plates",
    "Smelt and collect 10 copper plates in the furnace",
    "Craft a lab and complete the automation-science trigger",
    "Supply steam power to the lab",
    "Hand-craft and research with 75 red science packs"
   ],
   "currentStep": 2,
   "operations": [
    {
     "name": "move_items_exact",
     "args": {
      "item_name": "copper-ore",
      "unit_number": 15,
      "max_count": 10,
      "to_entity": true
     }
    }
   ],
   "checkpoint": {
    "mode": "all",
    "requirements": [
     {
      "id": "requirement_1",
      "kind": "entity_inventory_count",
      "unit_number": 15,
      "item_name": "copper-plate",
      "minimum": 10
     }
    ],
    "confidence": 0,
    "source": "planner_semantic_checkpoint"
   },
   "roadmapNodeIds": [
    "triggers"
   ],
   "developmentMode": "vertical",
   "timeReview": {
    "decision": "parallelize",
    "reason": "The iron-plate transfer is receipt-verified. Load the known carried copper ore into the same furnace now; next observe the live smelting state before deciding whether to wait."
   }
  },
  "req_muw0mkcw_1.turn7.craft_plates_by_hand": {
   "chatMessage": "",
   "plan": [
    "Smelt 50 iron plates and 10 copper plates and complete their exact research triggers",
    "Craft a lab and complete the automation-science trigger to unlock red science",
    "Supply steam power to the lab",
    "Hand-craft and research with 75 red science packs"
   ],
   "currentStep": 0,
   "operations": [
    {
     "name": "craft_item",
     "args": {
      "item_name": "iron-plate",
      "count": 50
     }
    },
    {
     "name": "craft_item",
     "args": {
      "item_name": "copper-plate",
      "count": 10
     }
    }
   ],
   "checkpoint": {
    "mode": "all",
    "requirements": [
     {
      "id": "requirement_1",
      "kind": "inventory_count",
      "item_name": "iron-plate",
      "minimum": 50
     },
     {
      "id": "requirement_2",
      "kind": "inventory_count",
      "item_name": "copper-plate",
      "minimum": 10
     }
    ],
    "confidence": 0,
    "source": "planner_semantic_checkpoint"
   }
  },
  "req_muw0mkcw_1.turn7.supply_coal_not_held": {
   "chatMessage": "The observed stone furnace has 50 iron ore loaded but is empty of plates; I’ll now put coal into it to make that smelting run possible.",
   "plan": [
    "Smelt 50 iron plates and 10 copper plates and complete their exact research triggers",
    "Craft a lab and complete the automation-science trigger to unlock red science",
    "Supply steam power to the lab",
    "Hand-craft and research with 75 red science packs"
   ],
   "currentStep": 0,
   "operations": [
    {
     "name": "supply_entity",
     "args": {
      "unit_number": 15,
      "items": [
       {
        "item_name": "coal",
        "count": 10
       }
      ]
     }
    }
   ]
  },
  "req_muw0tw25_2.turn1.planner_commit": {
   "chatMessage": "I’ll revise the same goal around the requested recoverable dependency: first gather 30 coal, then fuel the observed furnace and complete iron smelting before returning to copper and the remaining research steps.",
   "plan": [
    "Gather 30 coal from natural deposits",
    "Fuel the existing stone furnace with 50 iron ore loaded, smelt and collect 50 iron plates",
    "Smelt and collect 10 copper plates in the furnace",
    "Craft a lab and complete the automation-science trigger",
    "Supply steam power to the lab",
    "Hand-craft and research with 75 red science packs"
   ],
   "currentStep": 0,
   "operations": [
    {
     "name": "gather_resource",
     "args": {
      "resource_name": "coal",
      "count": 30,
      "search_radius": 256
     }
    }
   ],
   "checkpoint": {
    "mode": "all",
    "requirements": [
     {
      "id": "requirement_1",
      "kind": "inventory_count",
      "item_name": "coal",
      "minimum": 30
     }
    ],
    "confidence": 0,
    "source": "planner_semantic_checkpoint"
   }
  },
  "req_muw0tw25_2.turn2.load_coal": {
   "chatMessage": "",
   "plan": [
    "Gather 30 coal from natural deposits",
    "Fuel the existing stone furnace with 50 iron ore loaded, smelt and collect 50 iron plates",
    "Smelt and collect 10 copper plates in the furnace",
    "Craft a lab and complete the automation-science trigger",
    "Supply steam power to the lab",
    "Hand-craft and research with 75 red science packs"
   ],
   "currentStep": 1,
   "operations": [
    {
     "name": "move_items_exact",
     "args": {
      "item_name": "coal",
      "unit_number": 15,
      "max_count": 30,
      "to_entity": true
     }
    }
   ]
  },
  "req_muw0tw25_2.turn3.load_ore_already_loaded": {
   "chatMessage": "",
   "plan": [
    "Gather 30 coal from natural deposits",
    "Fuel the existing stone furnace with 50 iron ore loaded, smelt and collect 50 iron plates",
    "Smelt and collect 10 copper plates in the furnace",
    "Craft a lab and complete the automation-science trigger",
    "Supply steam power to the lab",
    "Hand-craft and research with 75 red science packs"
   ],
   "currentStep": 1,
   "operations": [
    {
     "name": "move_items_exact",
     "args": {
      "item_name": "iron-ore",
      "unit_number": 15,
      "max_count": 50,
      "to_entity": true
     }
    }
   ],
   "checkpoint": {
    "mode": "all",
    "requirements": [
     {
      "id": "requirement_1",
      "kind": "entity_inventory_count",
      "unit_number": 15,
      "item_name": "iron-ore",
      "minimum": 50
     }
    ],
    "confidence": 0,
    "source": "planner_semantic_checkpoint"
   }
  },
  "req_muw17okc_4.turn1.planner_commit": {
   "chatMessage": "I’ll take the 10 finished copper plates from the observed furnace, preserving the 58 iron plates already collected.",
   "plan": [
    "Collect 10 copper plates from the furnace",
    "Gather and smelt any additional copper needed for the live lab recipe",
    "Craft one lab to trigger automation science",
    "Supply steam power to the lab",
    "Craft red science packs and research logistic science"
   ],
   "currentStep": 0,
   "operations": [
    {
     "name": "move_items_exact",
     "args": {
      "item_name": "copper-plate",
      "unit_number": 15,
      "max_count": 10,
      "to_entity": false
     }
    }
   ],
   "checkpoint": {
    "mode": "all",
    "requirements": [
     {
      "id": "requirement_1",
      "kind": "inventory_count",
      "item_name": "copper-plate",
      "minimum": 10
     }
    ],
    "confidence": 0,
    "source": "planner_semantic_checkpoint"
   }
  },
  "req_muw17okc_4.turn2.executor_zero_operations": {
   "chatMessage": "",
   "plan": [
    "Collect 10 copper plates from the furnace",
    "Gather and smelt any additional copper needed for the live lab recipe",
    "Craft one lab to trigger automation science",
    "Supply steam power to the lab",
    "Craft red science packs and research logistic science"
   ],
   "currentStep": 1,
   "operations": []
  },
  "req_muw17okc_4.turn2.repair_zero_operations": {
   "chatMessage": "I’ll check the live lab recipe and current inventory to determine whether additional copper is needed.",
   "plan": [
    "Collect 10 copper plates from the furnace",
    "Gather and smelt any additional copper needed for the live lab recipe",
    "Craft one lab to trigger automation science",
    "Supply steam power to the lab",
    "Craft red science packs and research logistic science"
   ],
   "currentStep": 1,
   "operations": []
  }
 },
 "worldReads": {
  "recipeLab": "{\"found\":true,\"query\":\"lab\",\"truncated\":false,\"rate_basis\":\"from prototypes; excludes modules, beacons, quality and recipe productivity research; assumes inputs and fuel never run out\",\"recipes\":[{\"name\":\"lab\",\"enabled\":true,\"requested_crafts\":1,\"craftable_now_count\":0,\"craftable_now\":false,\"inventory_overlay\":{\"outputs\":[{\"type\":\"item\",\"name\":\"lab\",\"required\":1,\"held\":0}],\"ingredients\":[{\"type\":\"item\",\"name\":\"iron-gear-wheel\",\"required\":10,\"held\":0,\"missing\":10,\"status\":\"needs_crafting\"},{\"type\":\"item\",\"name\":\"electronic-circuit\",\"required\":10,\"held\":0,\"missing\":10,\"status\":\"needs_crafting\"},{\"type\":\"item\",\"name\":\"transport-belt\",\"required\":4,\"held\":0,\"missing\":4,\"status\":\"needs_crafting\"}]},\"bootstrap\":{\"dependencies\":[{\"type\":\"item\",\"name\":\"iron-gear-wheel\",\"required\":10,\"held\":0,\"missing\":10,\"status\":\"needs_crafting\",\"resolution\":{\"kind\":\"crafting\",\"recipe_name\":\"iron-gear-wheel\",\"categories\":[\"crafting\"],\"crafts_needed\":10,\"producer_candidates\":[\"iron-gear-wheel\"]},\"dependencies\":[{\"type\":\"item\",\"name\":\"iron-plate\",\"required\":20,\"held\":58,\"missing\":0,\"status\":\"already_satisfied\",\"role\":\"ingredient\"}],\"role\":\"ingredient\"},{\"type\":\"item\",\"name\":\"electronic-circuit\",\"required\":10,\"held\":0,\"missing\":10,\"status\":\"needs_crafting\",\"resolution\":{\"kind\":\"crafting\",\"recipe_name\":\"electronic-circuit\",\"categories\":[\"electronics\"],\"crafts_needed\":10,\"producer_candidates\":[\"electronic-circuit\"]},\"dependencies\":[{\"type\":\"item\",\"name\":\"iron-plate\",\"required\":10,\"held\":58,\"missing\":0,\"status\":\"already_satisfied\",\"role\":\"ingredient\"},{\"type\":\"item\",\"name\":\"copper-cable\",\"required\":30,\"held\":0,\"missing\":30,\"status\":\"needs_crafting\",\"resolution\":{\"kind\":\"crafting\",\"recipe_name\":\"copper-cable\",\"categories\":[\"electronics\"],\"crafts_needed\":15,\"producer_candidates\":[\"copper-cable\"]},\"dependencies\":[{\"type\":\"item\",\"name\":\"copper-plate\",\"required\":15,\"held\":0,\"missing\":15,\"status\":\"needs_acquisition/processing\",\"resolution\":{\"kind\":\"processing\",\"recipe_name\":\"copper-plate\",\"categories\":[\"smelting\"],\"crafts_needed\":15,\"producer_candidates\":[\"copper-plate\"]},\"machine_dependency\":{\"required\":1,\"held\":0,\"status\":\"needs_acquisition/processing\",\"satisfaction_scope\":\"inventory_acquisition\",\"placed_instance_required\":true,\"matched_count\":3,\"truncated\":false,\"candidates\":[{\"name\":\"electric-furnace\",\"type\":\"furnace\",\"held_count\":0,\"place_items\":[{\"name\":\"electric-furnace\",\"count\":1}]},{\"name\":\"steel-furnace\",\"type\":\"furnace\",\"held_count\":0,\"place_items\":[{\"name\":\"steel-furnace\",\"count\":1}]},{\"name\":\"stone-furnace\",\"type\":\"furnace\",\"held_count\":0,\"place_items\":[{\"name\":\"stone-furnace\",\"count\":1}]}],\"selected_item_dependency\":{\"type\":\"item\",\"name\":\"electric-furnace\",\"required\":1,\"held\":0,\"missing\":1,\"status\":\"needs_acquisition/processing\",\"resolution\":{\"kind\":\"acquisition\",\"producer_candidates\":{}},\"role\":\"crafting_machine\"}},\"dependencies\":[{\"type\":\"item\",\"name\":\"copper-ore\",\"required\":15,\"held\":0,\"missing\":15,\"status\":\"needs_acquisition/processing\",\"resolution\":{\"kind\":\"acquisition\",\"producer_candidates\":{}},\"role\":\"ingredient\"}],\"role\":\"ingredient\"}],\"role\":\"ingredient\"}],\"role\":\"ingredient\"},{\"type\":\"item\",\"name\":\"transport-belt\",\"required\":4,\"held\":0,\"missing\":4,\"status\":\"needs_crafting\",\"resolution\":{\"kind\":\"crafting\",\"recipe_name\":\"transport-belt\",\"categories\":[\"pressing\"],\"crafts_needed\":2,\"producer_candidates\":[\"transport-belt\"]},\"dependencies\":[{\"type\":\"item\",\"name\":\"iron-plate\",\"required\":2,\"held\":58,\"missing\":0,\"status\":\"already_satisfied\",\"role\":\"ingredient\"},{\"type\":\"item\",\"name\":\"iron-gear-wheel\",\"required\":2,\"held\":0,\"missing\":2,\"status\":\"needs_crafting\",\"resolution\":{\"kind\":\"crafting\",\"recipe_name\":\"iron-gear-wheel\",\"categories\":[\"crafting\"],\"crafts_needed\":2,\"producer_candidates\":[\"iron-gear-wheel\"]},\"dependencies\":[{\"type\":\"item\",\"name\":\"iron-plate\",\"required\":4,\"held\":58,\"missing\":0,\"status\":\"already_satisfied\",\"role\":\"ingredient\"}],\"role\":\"ingredient\"}],\"role\":\"ingredient\"}],\"first_unresolved\":{\"type\":\"item\",\"name\":\"iron-gear-wheel\",\"required\":10,\"held\":0,\"missing\":10,\"status\":\"needs_crafting\",\"resolution\":{\"kind\":\"crafting\",\"recipe_name\":\"iron-gear-wheel\",\"categories\":[\"crafting\"],\"crafts_needed\":10,\"producer_candidates\":[\"iron-gear-wheel\"]},\"dependencies\":[{\"type\":\"item\",\"name\":\"iron-plate\",\"required\":20,\"held\":58,\"missing\":0,\"status\":\"already_satisfied\",\"role\":\"ingredient\"}]}},\"hidden\":false,\"energy\":2,\"categories\":[\"crafting\"],\"hand_craftable_category\":true,\"hand_crafting\":{\"crafting_speed\":1,\"seconds_per_craft\":2},\"hidden_from_player_crafting\":false,\"ingredients\":[{\"type\":\"item\",\"name\":\"iron-gear-wheel\",\"amount\":10},{\"type\":\"item\",\"name\":\"electronic-circuit\",\"amount\":10},{\"type\":\"item\",\"name\":\"transport-belt\",\"amount\":4}],\"products\":[{\"type\":\"item\",\"name\":\"lab\",\"amount\":1}],\"crafting_machine_count\":3,\"crafting_machines\":[{\"name\":\"assembling-machine-1\",\"type\":\"assembling-machine\",\"crafting_speed\":0.5,\"seconds_per_craft\":4,\"crafts_per_second\":0.25,\"products_per_minute\":[{\"type\":\"item\",\"name\":\"lab\",\"per_minute\":15}],\"energy_source\":\"electric\",\"energy_watts\":75000},{\"name\":\"assembling-machine-2\",\"type\":\"assembling-machine\",\"crafting_speed\":0.75,\"seconds_per_craft\":2.666700000000000070343730840249918401241302490234375,\"crafts_per_second\":0.375,\"products_per_minute\":[{\"type\":\"item\",\"name\":\"lab\",\"per_minute\":22.5}],\"energy_source\":\"electric\",\"energy_watts\":150000},{\"name\":\"assembling-machine-3\",\"type\":\"assembling-machine\",\"crafting_speed\":1.25,\"seconds_per_craft\":1.600000000000000088817841970012523233890533447265625,\"crafts_per_second\":0.625,\"products_per_minute\":[{\"type\":\"item\",\"name\":\"lab\",\"per_minute\":37.5}],\"energy_source\":\"electric\",\"energy_watts\":375000}],\"crafting_machines_truncated\":false}]}\n",
  "recipeCopperPlate": "{\"found\":true,\"query\":\"copper-plate\",\"truncated\":false,\"rate_basis\":\"from prototypes; excludes modules, beacons, quality and recipe productivity research; assumes inputs and fuel never run out\",\"recipes\":[{\"name\":\"copper-plate\",\"enabled\":true,\"requested_crafts\":10,\"craftable_now_count\":0,\"craftable_now\":false,\"inventory_overlay\":{\"outputs\":[{\"type\":\"item\",\"name\":\"copper-plate\",\"required\":10,\"held\":0}],\"ingredients\":[{\"type\":\"item\",\"name\":\"copper-ore\",\"required\":10,\"held\":0,\"missing\":10,\"status\":\"needs_acquisition/processing\"}],\"machine_dependency\":{\"required\":1,\"held\":0,\"status\":\"needs_acquisition/processing\",\"satisfaction_scope\":\"inventory_acquisition\",\"placed_instance_required\":true,\"matched_count\":3,\"truncated\":false,\"candidates\":[{\"name\":\"electric-furnace\",\"type\":\"furnace\",\"held_count\":0,\"place_items\":[{\"name\":\"electric-furnace\",\"count\":1}]},{\"name\":\"steel-furnace\",\"type\":\"furnace\",\"held_count\":0,\"place_items\":[{\"name\":\"steel-furnace\",\"count\":1}]},{\"name\":\"stone-furnace\",\"type\":\"furnace\",\"held_count\":0,\"place_items\":[{\"name\":\"stone-furnace\",\"count\":1}]}],\"selected_item_dependency\":{\"type\":\"item\",\"name\":\"electric-furnace\",\"required\":1,\"held\":0,\"missing\":1,\"status\":\"needs_acquisition/processing\",\"resolution\":{\"kind\":\"acquisition\",\"producer_candidates\":{}},\"role\":\"crafting_machine\"}}},\"bootstrap\":{\"dependencies\":[{\"type\":\"item\",\"name\":\"copper-ore\",\"required\":10,\"held\":0,\"missing\":10,\"status\":\"needs_acquisition/processing\",\"resolution\":{\"kind\":\"acquisition\",\"producer_candidates\":{}},\"role\":\"ingredient\"}],\"first_unresolved\":{\"type\":\"item\",\"name\":\"electric-furnace\",\"required\":1,\"held\":0,\"missing\":1,\"status\":\"needs_acquisition/processing\",\"resolution\":{\"kind\":\"acquisition\",\"producer_candidates\":{}},\"role\":\"crafting_machine\"}},\"hidden\":false,\"energy\":3.20000000000000017763568394002504646778106689453125,\"categories\":[\"smelting\"],\"hand_craftable_category\":false,\"hidden_from_player_crafting\":false,\"ingredients\":[{\"type\":\"item\",\"name\":\"copper-ore\",\"amount\":1}],\"products\":[{\"type\":\"item\",\"name\":\"copper-plate\",\"amount\":1}],\"crafting_machine_count\":3,\"crafting_machines\":[{\"name\":\"electric-furnace\",\"type\":\"furnace\",\"crafting_speed\":2,\"seconds_per_craft\":1.600000000000000088817841970012523233890533447265625,\"crafts_per_second\":0.625,\"products_per_minute\":[{\"type\":\"item\",\"name\":\"copper-plate\",\"per_minute\":37.5}],\"energy_source\":\"electric\",\"energy_watts\":180000},{\"name\":\"steel-furnace\",\"type\":\"furnace\",\"crafting_speed\":2,\"seconds_per_craft\":1.600000000000000088817841970012523233890533447265625,\"crafts_per_second\":0.625,\"products_per_minute\":[{\"type\":\"item\",\"name\":\"copper-plate\",\"per_minute\":37.5}],\"energy_source\":\"burner\",\"energy_watts\":90000,\"burner_effectivity\":1,\"fuel_categories\":[\"chemical\"]},{\"name\":\"stone-furnace\",\"type\":\"furnace\",\"crafting_speed\":1,\"seconds_per_craft\":3.20000000000000017763568394002504646778106689453125,\"crafts_per_second\":0.3125,\"products_per_minute\":[{\"type\":\"item\",\"name\":\"copper-plate\",\"per_minute\":18.75}],\"energy_source\":\"burner\",\"energy_watts\":90000,\"burner_effectivity\":1,\"fuel_categories\":[\"chemical\"]}],\"crafting_machines_truncated\":false}]}\n",
  "recipeIronPlate": "{\"found\":true,\"query\":\"iron-plate\",\"truncated\":false,\"rate_basis\":\"from prototypes; excludes modules, beacons, quality and recipe productivity research; assumes inputs and fuel never run out\",\"recipes\":[{\"name\":\"iron-plate\",\"enabled\":true,\"requested_crafts\":42,\"craftable_now_count\":0,\"craftable_now\":false,\"inventory_overlay\":{\"outputs\":[{\"type\":\"item\",\"name\":\"iron-plate\",\"required\":42,\"held\":8}],\"ingredients\":[{\"type\":\"item\",\"name\":\"iron-ore\",\"required\":42,\"held\":42,\"missing\":0,\"status\":\"already_satisfied\"}],\"machine_dependency\":{\"required\":1,\"held\":1,\"status\":\"already_satisfied\",\"satisfaction_scope\":\"inventory_acquisition\",\"placed_instance_required\":true,\"matched_count\":3,\"truncated\":false,\"candidates\":[{\"name\":\"stone-furnace\",\"type\":\"furnace\",\"held_count\":1,\"place_items\":[{\"name\":\"stone-furnace\",\"count\":1}]},{\"name\":\"electric-furnace\",\"type\":\"furnace\",\"held_count\":0,\"place_items\":[{\"name\":\"electric-furnace\",\"count\":1}]},{\"name\":\"steel-furnace\",\"type\":\"furnace\",\"held_count\":0,\"place_items\":[{\"name\":\"steel-furnace\",\"count\":1}]}]}},\"bootstrap\":{\"dependencies\":[{\"type\":\"item\",\"name\":\"iron-ore\",\"required\":42,\"held\":42,\"missing\":0,\"status\":\"already_satisfied\",\"role\":\"ingredient\"}]},\"hidden\":false,\"energy\":3.20000000000000017763568394002504646778106689453125,\"categories\":[\"smelting\"],\"hand_craftable_category\":false,\"hidden_from_player_crafting\":false,\"ingredients\":[{\"type\":\"item\",\"name\":\"iron-ore\",\"amount\":1}],\"products\":[{\"type\":\"item\",\"name\":\"iron-plate\",\"amount\":1}],\"crafting_machine_count\":3,\"crafting_machines\":[{\"name\":\"electric-furnace\",\"type\":\"furnace\",\"crafting_speed\":2,\"seconds_per_craft\":1.600000000000000088817841970012523233890533447265625,\"crafts_per_second\":0.625,\"products_per_minute\":[{\"type\":\"item\",\"name\":\"iron-plate\",\"per_minute\":37.5}],\"energy_source\":\"electric\",\"energy_watts\":180000},{\"name\":\"steel-furnace\",\"type\":\"furnace\",\"crafting_speed\":2,\"seconds_per_craft\":1.600000000000000088817841970012523233890533447265625,\"crafts_per_second\":0.625,\"products_per_minute\":[{\"type\":\"item\",\"name\":\"iron-plate\",\"per_minute\":37.5}],\"energy_source\":\"burner\",\"energy_watts\":90000,\"burner_effectivity\":1,\"fuel_categories\":[\"chemical\"],\"fuel\":{\"name\":\"coal\",\"accepted\":true,\"fuel_value_joules\":4000000,\"per_minute\":1.350000000000000088817841970012523233890533447265625}},{\"name\":\"stone-furnace\",\"type\":\"furnace\",\"crafting_speed\":1,\"seconds_per_craft\":3.20000000000000017763568394002504646778106689453125,\"crafts_per_second\":0.3125,\"products_per_minute\":[{\"type\":\"item\",\"name\":\"iron-plate\",\"per_minute\":18.75}],\"energy_source\":\"burner\",\"energy_watts\":90000,\"burner_effectivity\":1,\"fuel_categories\":[\"chemical\"],\"fuel\":{\"name\":\"coal\",\"accepted\":true,\"fuel_value_joules\":4000000,\"per_minute\":1.350000000000000088817841970012523233890533447265625}}],\"crafting_machines_truncated\":false}]}\n",
  "technologyElectronics": "{\"found\":true,\"name\":\"electronics\",\"level\":1,\"max_level\":1,\"researched\":true,\"enabled\":true,\"trigger_type\":\"craft-item\",\"saved_progress\":0,\"ingredients\":{},\"ingredients_truncated\":false,\"prerequisites\":{},\"prerequisites_truncated\":false,\"research_trigger\":{\"type\":\"craft-item\",\"item\":\"copper-plate\",\"count\":10}}\n",
  "technologyAutomationScience": "{\"found\":true,\"name\":\"automation-science-pack\",\"level\":1,\"max_level\":1,\"researched\":false,\"enabled\":true,\"request_error\":\"trigger_research\",\"trigger_type\":\"craft-item\",\"saved_progress\":0,\"ingredients\":{},\"ingredients_truncated\":false,\"prerequisites\":[{\"name\":\"steam-power\",\"researched\":true},{\"name\":\"electronics\",\"researched\":true}],\"prerequisites_truncated\":false,\"research_trigger\":{\"type\":\"craft-item\",\"item\":\"lab\",\"count\":1}}\n",
  "inventoryReq1Turn7": "{\n  {\n    count = 1,\n    name = \"burner-mining-drill\"\n  },\n  {\n    count = 10,\n    name = \"copper-ore\"\n  },\n  {\n    count = 8,\n    name = \"iron-plate\"\n  }\n}\n",
  "inventoryReq4": "{\n  {\n    count = 1,\n    name = \"burner-mining-drill\"\n  },\n  {\n    count = 58,\n    name = \"iron-plate\"\n  }\n}\n",
  "furnaceOre50NoFuel": {
   "found": true,
   "entity": {
    "name": "stone-furnace",
    "type": "furnace",
    "position": {
     "y": 55,
     "x": 19
    },
    "force": "player",
    "unit_number": 15,
    "direction": 0,
    "supports_direction": false,
    "rotatable": true,
    "status": 53,
    "working": false,
    "inventories": [
     {
      "index": 1,
      "items": {}
     },
     {
      "index": 2,
      "items": [
       {
        "name": "iron-ore",
        "quality": "normal",
        "count": 50
       }
      ]
     },
     {
      "index": 3,
      "items": {}
     },
     {
      "index": 4,
      "items": {}
     },
     {
      "index": 6,
      "items": {}
     },
     {
      "index": 8,
      "items": {}
     }
    ],
    "inventories_truncated": false,
    "inventory_items_truncated": false
   }
  },
  "furnace47Plates": {
   "found": true,
   "entity": {
    "name": "stone-furnace",
    "type": "furnace",
    "position": {
     "y": 55,
     "x": 19
    },
    "force": "player",
    "unit_number": 15,
    "direction": 0,
    "supports_direction": false,
    "rotatable": true,
    "status": 1,
    "working": true,
    "inventories": [
     {
      "index": 1,
      "items": [
       {
        "name": "coal",
        "quality": "normal",
        "count": 26
       }
      ]
     },
     {
      "index": 2,
      "items": [
       {
        "name": "iron-ore",
        "quality": "normal",
        "count": 2
       }
      ]
     },
     {
      "index": 3,
      "items": [
       {
        "name": "iron-plate",
        "quality": "normal",
        "count": 47
       }
      ]
     },
     {
      "index": 4,
      "items": {}
     },
     {
      "index": 6,
      "items": {}
     },
     {
      "index": 8,
      "items": {}
     }
    ],
    "inventories_truncated": false,
    "inventory_items_truncated": false
   }
  },
  "furnaceCopper10": {
   "found": true,
   "actor_position": {
    "y": 64.60546875,
    "x": 20.40234375
   },
   "entity": {
    "name": "stone-furnace",
    "type": "furnace",
    "position": {
     "y": 55,
     "x": 19
    },
    "force": "player",
    "unit_number": 15,
    "direction": 0,
    "supports_direction": false,
    "rotatable": true,
    "status": 18,
    "working": false,
    "inventories": [
     {
      "index": 1,
      "items": [
       {
        "name": "coal",
        "quality": "normal",
        "count": 25
       }
      ]
     },
     {
      "index": 2,
      "items": {}
     },
     {
      "index": 3,
      "items": [
       {
        "name": "copper-plate",
        "quality": "normal",
        "count": 10
       }
      ]
     },
     {
      "index": 4,
      "items": {}
     },
     {
      "index": 6,
      "items": {}
     },
     {
      "index": 8,
      "items": {}
     }
    ],
    "inventories_truncated": false,
    "inventory_items_truncated": false
   }
  },
  "nearbyFurnaceReq4": {
   "actor_position": {
    "y": 64.60546875,
    "x": 20.40234375
   },
   "radius": 10,
   "matched_count": 1,
   "returned_count": 1,
   "truncated": false,
   "entities": [
    {
     "name": "stone-furnace",
     "type": "furnace",
     "position": {
      "y": 55,
      "x": 19
     },
     "force": "player",
     "unit_number": 15,
     "direction": 0,
     "supports_direction": false,
     "rotatable": true,
     "reference": "entity:15"
    }
   ]
  },
  "actorStatusReq4": "{\"mode\":\"npc\",\"actor\":{\"kind\":\"standalone_character\",\"valid\":true,\"name\":\"Piper-1\",\"npc_id\":\"npc-1\",\"position\":{\"y\":64.60546875,\"x\":20.40234375},\"has_character\":true,\"actor_id\":10,\"selected_entity\":{\"name\":\"coal\",\"position\":{\"y\":89.5,\"x\":19.5}},\"mining_state\":{\"mining\":false,\"position\":{\"y\":0,\"x\":0}},\"mining_progress\":0},\"connected_players\":0,\"load_reconciliation\":{\"policy\":\"discard_autorio_tasks_and_stop_npc_controls_on_load\",\"owned_crafting_policy\":\"cancel_persisted_autorio_owned_native_queue_on_load\",\"trigger\":\"lazy_in_single_player_replicated_remote_call_in_multiplayer\",\"pending\":false,\"last_actor_id\":10,\"last_tick\":10},\"death_recovery\":{\"policy\":\"discard_autorio_tasks_and_create_empty_replacement\"}}\n"
 },
 "receipts": {
  "req_muw0tw25_2.turn3.item_missing": "[MOD] Autorio operation error: moving_items failed: item_missing; dependent operations cancelled. A failure cancels the operations queued behind it; a refused item move (nothing moved, items still held) does not, so read the receipt for which operations completed. Detailed task receipt: {\"observation_mode\":\"diff\",\"task_state\":\"idle\",\"queue_empty\":true,\"queue_length\":0,\"last_cancelled_batch\":{\"batch_id\":10,\"task_count\":1,\"task_types\":[\"moving_items\"],\"tick\":32190,\"reason\":\"moving_items:item_missing\"},\"basic_operation\":{\"last_result\":{\"operation_id\":10,\"type\":\"moving_items\",\"accepted\":false,\"completed\":false,\"code\":\"item_missing\",\"tick\":32190,\"actor_id\":10,\"actor_kind\":\"standalone_character\",\"force_index\":1,\"target_unit_number\":15,\"item_name\":\"iron-ore\",\"requested_count\":50,\"to_entity\":true}}}"
 }
}
