-- Test-only fixture. Append to a DISPOSABLE copy of guarded control.lua, never
-- the shipped mod. Calls use the real compiled guard and real native actor.
-- Synthetic durable-state fault injections below run inside that mod's storage.
--
-- On both unchanged baseline and candidate, with an isolated zero-human world:
--   remote.call("sgluna_deployment_guard_test", "run", "prepare")
-- Persist its complete reply BEFORE checking ok. Save, stop, restart that save
-- with the exact same mod bytes, then call run("verify") and persist its reply.
-- No params beyond the phase are required. Both phases finish disabled/idle.
-- Baseline prepare must fail disabled.*.allowed/current_epoch (Lua '' truthiness),
-- not a missing fixture API. No provider, gameplay action or recovery is used.

remote.add_interface("sgluna_deployment_guard_test", {
  run = function(phase)
    local checks = {}
    local function check(name, actual, expected)
      checks[#checks + 1] = {
        name = name,
        ok = actual == expected,
        actual = actual == nil and "<nil>" or actual,
        expected = expected == nil and "<nil>" or expected
      }
    end
    local function guard(method, ...)
      return remote.call("sgluna_deployment", method, ...)
    end
    local function snapshot()
      return guard("status")
    end
    local function denied(name, old_epoch)
      local status = snapshot()
      check(name .. ".allowed", status.allowed, false)
      check(name .. ".old_epoch", guard("authorize", old_epoch), false)
      check(name .. ".current_epoch", guard("authorize", status.epoch), false)
      return status
    end
    local function configure(session)
      check("configure." .. session, guard("configure", "npc", session), session)
      local status = snapshot()
      check("configure." .. session .. ".allowed", status.allowed, true)
      check("configure." .. session .. ".current_epoch", guard("authorize", status.epoch), true)
      check("configure." .. session .. ".npc", status.actor_kind, "standalone_character")
      return status
    end

    check("zero_humans", #game.connected_players, 0)
    check("normal_speed", game.speed, 1)
    if phase == "prepare" then
      local configured = configure("guard-native-initial")
      check("cancel.reply", guard("cancel"), true)
      local cancelled = snapshot()
      check("cancel.epoch", cancelled.epoch, configured.epoch + 1)
      check("cancel.allowed", cancelled.allowed, true)
      check("cancel.old_epoch", guard("authorize", configured.epoch), false)
      check("cancel.current_epoch", guard("authorize", cancelled.epoch), true)

      check("disable.reply", guard("disable"), true)
      local disabled = denied("disabled", configured.epoch)
      check("disabled.cancelled_epoch", guard("authorize", cancelled.epoch), false)
      check("disabled.session", disabled.session, "")
      check("disabled.epoch", disabled.epoch, cancelled.epoch + 1)
      check("disabled.idle", disabled.idle, true)
      check("disabled.repeat_reply", guard("disable"), true)
      local repeated = denied("disabled.repeat", disabled.epoch)
      check("disabled.repeat_epoch", repeated.epoch, disabled.epoch + 1)
      guard("cancel")
      local final = denied("disabled.after_cancel", repeated.epoch)
      storage.sgluna_deployment_guard_test = {
        old_epoch = configured.epoch,
        disabled_epoch = final.epoch,
        disabled_actor_id = final.actor_id,
        prepared = true
      }
    elseif phase == "verify" then
      local saved = storage.sgluna_deployment_guard_test
      check("restart.prepared", saved and saved.prepared, true)
      if saved and saved.prepared then
        local restored = denied("restart.disabled", saved.old_epoch)
        check("restart.epoch_retained", restored.epoch, saved.disabled_epoch)
        check("restart.disabled_epoch", guard("authorize", saved.disabled_epoch), false)
        check("restart.session", restored.session, "")
        check("restart.idle", restored.idle, true)
        local rebound = configure("guard-native-after-restart")
        check("restart.reconfigure_epoch", rebound.epoch, saved.disabled_epoch + 1)
        check("restart.old_epoch", guard("authorize", saved.old_epoch), false)
        check("restart.pre_reconfigure_epoch", guard("authorize", saved.disabled_epoch), false)

        -- Synthetic invalid external input. Rejection must precede cancellation,
        -- actor mutation and epoch changes, while preserving the valid binding.
        local invalid = {
          {name = "empty", value = ""}, {name = "nil"},
          {name = "false", value = false}, {name = "zero", value = 0},
          {name = "table", value = {}}
        }
        for _, variant in ipairs(invalid) do
          local before = snapshot()
          check("invalid_configure." .. variant.name, guard("configure", "npc", variant.value), false)
          local after = snapshot()
          check("invalid_configure." .. variant.name .. ".epoch", after.epoch, before.epoch)
          check("invalid_configure." .. variant.name .. ".session", after.session, before.session)
          check("invalid_configure." .. variant.name .. ".allowed", after.allowed, true)
        end
        check("invalid_configure.mode", guard("configure", "swarm", "guard-invalid-mode"), false)

        -- Residual durable corruption bypasses configure prevention deliberately.
        -- Status/authorize must detect it; only explicit valid reconfiguration
        -- may grant a new epoch. Never auto-rebind a disabled or corrupt session.
        for _, variant in ipairs(invalid) do
          local before = snapshot()
          storage.sgluna_deployment_session = variant.value
          denied("invalid_durable." .. variant.name, before.epoch)
          local fresh = configure("guard-native-repaired-" .. variant.name)
          check("invalid_durable." .. variant.name .. ".old_epoch", guard("authorize", before.epoch), false)
          check("invalid_durable." .. variant.name .. ".epoch", fresh.epoch, before.epoch + 1)
        end

        -- Synthetic stale binding fields; live actor and operations are unchanged.
        local before = snapshot()
        storage.sgluna_deployment_actor_id = before.actor_id + 1
        denied("stale_actor", before.epoch)
        configure("guard-native-after-stale-actor")
        before = snapshot()
        storage.sgluna_deployment_mode = "player"
        denied("stale_mode", before.epoch)
        configure("guard-native-after-stale-mode")
        before = snapshot()
        storage.sgluna_deployment_actor_kind = "connected_player"
        denied("stale_actor_kind", before.epoch)
        configure("guard-native-after-stale-kind")
        guard("cancel")
        guard("disable")
        local final = denied("final.disabled", before.epoch)
        check("final.idle", final.idle, true)
        storage.sgluna_deployment_guard_test.verified = true
      end
    else
      check("phase.supported", phase, "prepare or verify")
    end
    local ok = true
    for _, item in ipairs(checks) do
      if not item.ok then ok = false end
    end
    return {fixture = "deployment_guard_lifecycle_v1", phase = phase, ok = ok, checks = checks, final = snapshot()}
  end
})
