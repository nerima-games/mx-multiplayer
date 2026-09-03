/**
 * Writing an accepted `AuthoritativeCommand` through to mc-sim.
 *
 * ---------------------------------------------------------------------------
 * The gap this file closes
 * ---------------------------------------------------------------------------
 *
 * `domain/authoritative-session.ts` is a ledger: `AuthoritativeSession`
 * decides ORDER (a world-scoped revision) and IDEMPOTENCY (a per-command-id
 * result cache), and its own header says "game-rule validation stays in the
 * caller." Before this file, nothing in this repository was that caller —
 * verified by `grep -rl '@nerima-games/mc-sim' src test` returning nothing —
 * so a decoded `AuthoritativeCommand` could be admitted to the ledger and
 * still never touch a block of actual world state. `index.ts`'s header names
 * the rule this file follows: apply a remote peer's action by writing
 * through an mc-sim SERVICE, never by calling into a rules module.
 *
 * Four of the twenty `AuthoritativeCommand` tags are wired here —
 * `EntityPickupCommand`, `PlayerInventoryCommand`, `PlayerVitalsCommand` and
 * `VehicleCommand` — because those are the ones with an mc-sim service whose
 * shape needs no game-rule table this package would have to invent to use
 * it. The latter two are only PARTIALLY wired: each has actions this file
 * writes through (`PlayerInventoryCommand`'s `'select-slot'`, `'swap-items'`,
 * `'equip-item'`, `'unequip-item'`; `VehicleCommand`'s `'mount'`,
 * `'dismount'`) and actions it does not, for the same "no table to invent"
 * reason, returned as `CommandNotWritable` next to the applier that makes
 * the call — see `EAT_UNAVAILABLE_REASON` for the precedent and the
 * per-action reasons declared next to `applyPlayerInventory` and
 * `applyVehicle` for the rest.
 * `UNAVAILABLE_REASONS` below is the verified map of why every other WHOLE
 * tag is not written through: some have no mc-sim service at all, some have
 * one shaped for a single player where multiplayer needs a per-player
 * registry this file does not yet build.
 *
 * ---------------------------------------------------------------------------
 * `decided`, not `result._tag === 'AuthoritativeCommandAccepted'`
 * ---------------------------------------------------------------------------
 *
 * `AuthoritativeSession#execute` returns a CACHED result WITHOUT calling
 * `decide` again when `command.commandId` was already seen — that is the
 * whole point of its ledger. A caller that gates the mc-sim write on
 * `result._tag` alone cannot tell "accepted just now" from "accepted on an
 * earlier call, and this is a retransmit" and would redo the write on every
 * replay. For `VitalsService.addExhaustion`, which ADDS rather than SETS,
 * that is a double charge, not a harmless no-op. Every applier below sets a
 * local `decided` flag from inside the closure it hands `execute` — which
 * only runs on a fresh decision — and gates the mc-sim write on
 * `decided`, not merely on the result tag.
 *
 * `decide` itself must stay synchronous (see its signature on
 * `CommandDecision`); an mc-sim read is an Effect, so any read `decide`
 * needs (does the target entity still exist?) happens BEFORE `execute` is
 * called, and only its plain-value outcome crosses into the closure.
 */
import type { AuthoritativeCommand, AuthoritativeCommandResult, CommandId, PlayerId } from '../../domain/protocol.js'
import { AuthoritativeSession, type CommandDecision } from '../../domain/authoritative-session.js'
import {
  type EntityManagerApi,
  type HotbarServiceApi,
  type InventoryServiceApi,
  type Vehicle,
  type VehicleServiceApi,
  type VitalsServiceApi,
  EntityId as toSimEntityId,
  OccupantId as toSimOccupantId,
  VehicleId as toSimVehicleId,
} from '@nerima-games/mc-sim'
import { Effect } from 'effect'

/**
 * What a host must supply for the four command families this file writes
 * through. `entities` is narrowed to exactly the two methods used — `find`
 * and `despawn` — so this file does not depend on the host's entity
 * behaviour type beyond what `EntityManagerApi` already keeps agnostic to it
 * in those two signatures (see mc-sim's `entity-manager.ts`).
 *
 * `vitalsFor`, `inventoryFor`, `hotbarFor` and `vehiclesFor` are lookups
 * rather than a single service instance, because mc-sim's `VitalsService`,
 * `InventoryService`, `HotbarService` and `VehicleService` are each one
 * `Context.Tag` per provide (one player's vitals, one player's inventory),
 * not a per-player registry like `EntityManagerApi` is generic over. A
 * multiplayer host holds N players; this file does not decide how the host
 * indexes them, only that it can be asked for one by `PlayerId`.
 * `inventoryFor`, `hotbarFor` and `vehiclesFor` are narrowed the same way
 * `entities` is, to exactly the methods `applyPlayerInventory` and
 * `applyVehicle` call — `hotbarFor` to `setSelectedSlot` alone, since
 * `select-slot` is the only `PlayerInventoryAction` `HotbarServiceApi`
 * backs.
 */
export type WorldWriteServices<Behaviour> = {
  readonly entities: Pick<EntityManagerApi<Behaviour>, 'find' | 'despawn'>
  readonly vitalsFor: (player: PlayerId) => VitalsServiceApi | undefined
  readonly inventoryFor: (
    player: PlayerId,
  ) => Pick<InventoryServiceApi, 'equipFromInventory' | 'moveStack' | 'unequipToInventory'> | undefined
  readonly hotbarFor: (player: PlayerId) => Pick<HotbarServiceApi, 'setSelectedSlot'> | undefined
  readonly vehiclesFor: (player: PlayerId) => Pick<VehicleServiceApi, 'dismount' | 'mount' | 'vehicles'> | undefined
}

/** A command this file has no mc-sim service to write through yet. See `UNAVAILABLE_REASONS`. */
export type CommandNotWritable = {
  readonly _tag: 'CommandNotWritable'
  readonly commandId: CommandId
  readonly commandTag: AuthoritativeCommand['_tag']
  readonly reason: string
}

export type CommandApplicationOutcome = AuthoritativeCommandResult | CommandNotWritable

type EntityPickupCommand = Extract<AuthoritativeCommand, { readonly _tag: 'EntityPickupCommand' }>
type PlayerInventoryCommand = Extract<AuthoritativeCommand, { readonly _tag: 'PlayerInventoryCommand' }>
type PlayerVitalsCommand = Extract<AuthoritativeCommand, { readonly _tag: 'PlayerVitalsCommand' }>
type VehicleCommand = Extract<AuthoritativeCommand, { readonly _tag: 'VehicleCommand' }>

/** Shared by every action-level carve-out below — see `EAT_UNAVAILABLE_REASON` for the first of these. */
const commandNotWritable = (
  command: { readonly commandId: CommandId; readonly _tag: AuthoritativeCommand['_tag'] },
  reason: string,
): CommandNotWritable => ({
  _tag: 'CommandNotWritable',
  commandId: command.commandId,
  commandTag: command._tag,
  reason,
})

/**
 * `EntityPickupCommand` — the exact "contested pickup" case
 * `stages/registration.ts` names as mc-sim's and mx-gameplay's to arbitrate,
 * not this package's. The arbitration primitive is `EntityManager.despawn`
 * itself: it is one `Ref.modify`, so of two pickups racing for the same
 * entity, at most one sees `true`. This applier's job ends at calling it —
 * not at deciding who should win.
 *
 * `find` runs first so `decide` can report `entity-dead` for a target that
 * is already gone (despawned by some other path, or a stale/replayed
 * command for an entity that never existed) rather than reporting a
 * misleading accept for a pickup that removed nothing.
 */
const applyEntityPickup =
  <Behaviour>(session: AuthoritativeSession, entities: Pick<EntityManagerApi<Behaviour>, 'find' | 'despawn'>) =>
  (command: EntityPickupCommand): Effect.Effect<AuthoritativeCommandResult> =>
    Effect.gen(function* () {
      const target = yield* entities.find(toSimEntityId(command.entityId))
      let decided = false
      const decide = (): CommandDecision => {
        decided = true
        if (target === undefined) {
          return { accepted: false, reason: 'entity-dead' }
        }
        return { accepted: true }
      }
      const result = session.execute(command, decide)
      if (decided && result._tag === 'AuthoritativeCommandAccepted') {
        yield* entities.despawn(toSimEntityId(command.entityId))
      }
      return result
    })

const MOVE_ITEM_UNAVAILABLE_REASON =
  "'move-item' carries a partial `count`, but `InventoryServiceApi.moveStack(sourceIndex, targetIndex)` — the only slot-to-slot transfer this service exposes — moves or merges the WHOLE stack and takes no count. Honoring `count` here would mean this package deciding what a partial move does (split the stack? clamp to available room?), which is exactly the kind of rule `domain/inventory.ts` owns, not this file."

const DROP_ITEM_UNAVAILABLE_REASON =
  "'drop-item' has to both remove `count` items from `source` and spawn a pickup-able entity in the world for them. `InventoryServiceApi` covers the removal, but the spawn half needs `EntityManagerApi<Behaviour>.spawn`, whose `SpawnRequest<Behaviour>` needs a `kind`, `healthPoints` and a host-typed `behaviour` this file has no dropped-item value for — the same host-behaviour gap `EntityAttackCommand`'s reason names below. Deciding what a dropped stack becomes as an entity is mx-gameplay's, not this file's."

/** The single `PlayerInventoryAction` variant `applySelectSlot` writes through, dispatched to `HotbarServiceApi`. */
type SelectSlotAction = Extract<PlayerInventoryCommand['action'], { readonly _tag: 'select-slot' }>

/** The three `PlayerInventoryAction` variants `applyPlayerInventory` writes through, dispatched to their `InventoryServiceApi` counterpart. */
type WritableInventoryAction = Extract<PlayerInventoryCommand['action'], { readonly _tag: 'equip-item' | 'swap-items' | 'unequip-item' }>

const isWritableInventoryAction = (action: PlayerInventoryCommand['action']): action is WritableInventoryAction =>
  action._tag === 'equip-item' || action._tag === 'swap-items' || action._tag === 'unequip-item'

/** Only called for `'move-item'`/`'drop-item'` — `applyPlayerInventory` special-cases `'select-slot'` before this runs, and `isWritableInventoryAction` has already ruled out the other three. */
const inventoryActionUnavailableReason = (
  action: Extract<PlayerInventoryCommand['action'], { readonly _tag: 'drop-item' | 'move-item' }>,
): string => {
  if (action._tag === 'move-item') {
    return MOVE_ITEM_UNAVAILABLE_REASON
  }
  return DROP_ITEM_UNAVAILABLE_REASON
}

const writeInventoryAction = (
  inventory: Pick<InventoryServiceApi, 'equipFromInventory' | 'moveStack' | 'unequipToInventory'>,
  action: WritableInventoryAction,
): Effect.Effect<unknown> => {
  if (action._tag === 'swap-items') {
    return inventory.moveStack(action.source, action.destination)
  }
  if (action._tag === 'equip-item') {
    return inventory.equipFromInventory(action.source, action.equipmentSlot)
  }
  return inventory.unequipToInventory(action.equipmentSlot, action.destination)
}

/**
 * `'select-slot'` writes through `HotbarServiceApi.setSelectedSlot`
 * unconditionally, the same "no domain check to fail" shape
 * `applyPlayerInventory` uses for its three `InventoryServiceApi` actions
 * below: `setSelectedSlot` clamps an out-of-range index via
 * `Hotbar.clampHotbarIndex` (mc-sim's domain/hotbar.ts) rather than
 * rejecting one, so there is no `CommandRejectionReason` this applier could
 * report even if it wanted to. Split out of `applyPlayerInventory` because
 * it writes through a different per-player lookup (`hotbarFor`, not
 * `inventoryFor`) — `HotbarService` and `InventoryService` are separate
 * mc-sim `Context.Tag`s.
 */
const applySelectSlot =
  (session: AuthoritativeSession, hotbarFor: (player: PlayerId) => Pick<HotbarServiceApi, 'setSelectedSlot'> | undefined) =>
  (command: PlayerInventoryCommand, action: SelectSlotAction): Effect.Effect<CommandApplicationOutcome> => {
    const hotbar = hotbarFor(command.player)
    if (hotbar === undefined) {
      return Effect.succeed(session.execute(command, () => ({ accepted: false, reason: 'unauthorized-player' })))
    }

    return Effect.gen(function* () {
      let decided = false
      const decide = (): CommandDecision => {
        decided = true
        return { accepted: true }
      }
      const result = session.execute(command, decide)
      if (decided && result._tag === 'AuthoritativeCommandAccepted') {
        yield* hotbar.setSelectedSlot(action.slot)
      }
      return result
    })
  }

/**
 * `PlayerInventoryCommand` — four of its six actions write through mc-sim
 * unconditionally, the same "no domain check to fail" shape
 * `applyPlayerVitals` uses for `'respawn'`/`'activity'`: none of
 * `setSelectedSlot`/`moveStack`/`equipFromInventory`/`unequipToInventory`
 * reject at the `CommandRejectionReason` level (there is no
 * `'invalid-slot'` literal in `protocol.ts`), they resolve to a
 * discriminated result mc-sim's own delta stream is expected to reflect.
 * `'select-slot'` is dispatched to `applySelectSlot` before the
 * `InventoryServiceApi`-backed check below runs, since it writes through a
 * different service. `'move-item'` and `'drop-item'` are not written
 * through — see the reasons above — and that check runs BEFORE
 * `inventoryFor` is consulted, same ordering `applyPlayerVitals` uses for
 * `'eat'`.
 */
const applyPlayerInventory =
  (
    session: AuthoritativeSession,
    inventoryFor: (
      player: PlayerId,
    ) => Pick<InventoryServiceApi, 'equipFromInventory' | 'moveStack' | 'unequipToInventory'> | undefined,
    hotbarFor: (player: PlayerId) => Pick<HotbarServiceApi, 'setSelectedSlot'> | undefined,
  ) =>
  (command: PlayerInventoryCommand): Effect.Effect<CommandApplicationOutcome> => {
    const { action } = command
    if (action._tag === 'select-slot') {
      return applySelectSlot(session, hotbarFor)(command, action)
    }

    if (!isWritableInventoryAction(action)) {
      return Effect.succeed(commandNotWritable(command, inventoryActionUnavailableReason(action)))
    }

    const inventory = inventoryFor(command.player)
    if (inventory === undefined) {
      return Effect.succeed(session.execute(command, () => ({ accepted: false, reason: 'unauthorized-player' })))
    }

    return Effect.gen(function* () {
      let decided = false
      const decide = (): CommandDecision => {
        decided = true
        return { accepted: true }
      }
      const result = session.execute(command, decide)
      if (decided && result._tag === 'AuthoritativeCommandAccepted') {
        yield* writeInventoryAction(inventory, action)
      }
      return result
    })
  }

const EAT_UNAVAILABLE_REASON =
  "mc-sim's VitalsServiceApi.eat takes numeric foodPoints/saturationModifier; mapping the wire format's item name to those numbers is a game-rule table (which item restores how much) that mc-sim does not expose. Writing it through would mean this package inventing that table itself, which plan.md §3.14 reserves for mx-gameplay."

/**
 * `PlayerVitalsCommand`'s `'respawn'` and `'activity'` actions write through
 * `VitalsServiceApi` unconditionally — deliberately not gated on, say,
 * "was the player actually dead": `Vitals.respawn` in mc-sim's own domain has
 * no such guard (unlike `applyDamage`/`heal`, which do check `isDead`), so
 * adding one here would be this package inventing a rule mc-sim's own
 * designer chose not to enforce. `'eat'` has no service to write through —
 * see `EAT_UNAVAILABLE_REASON`.
 */
const applyPlayerVitals =
  (session: AuthoritativeSession, vitalsFor: (player: PlayerId) => VitalsServiceApi | undefined) =>
  (command: PlayerVitalsCommand): Effect.Effect<CommandApplicationOutcome> => {
    const { action } = command
    if (action !== 'respawn' && action._tag === 'eat') {
      return Effect.succeed({
        _tag: 'CommandNotWritable',
        commandId: command.commandId,
        commandTag: command._tag,
        reason: EAT_UNAVAILABLE_REASON,
      })
    }

    const vitals = vitalsFor(command.player)
    if (vitals === undefined) {
      return Effect.succeed(session.execute(command, () => ({ accepted: false, reason: 'unauthorized-player' })))
    }

    return Effect.gen(function* () {
      let decided = false
      const decide = (): CommandDecision => {
        decided = true
        return { accepted: true }
      }
      const result = session.execute(command, decide)
      if (decided && result._tag === 'AuthoritativeCommandAccepted') {
        if (action === 'respawn') {
          yield* vitals.respawn
        } else {
          yield* vitals.addExhaustion(action.amount)
        }
      }
      return result
    })
  }

const VEHICLE_MOVE_UNAVAILABLE_REASON =
  "'move' asks to advance a vehicle by a `direction` ('forward'/'backward'), but `VehicleServiceApi.updateVelocity`/`updateTransform` (mc-sim's application/vehicle-service.ts) take an already-computed `VehicleVelocity` or transform — turning a direction into one needs a speed/acceleration constant and the vehicle's current `yawRadians` composed through mc-physics, which are movement rules this package would have to invent, not plumbing. `mount` and `dismount` need none of that: only vehicle and occupant identity, which this file already turns wire ids into elsewhere (see `toSimEntityId` above)."

type MountAction = 'dismount' | 'mount'
type SimVehicleId = ReturnType<typeof toSimVehicleId>
type SimOccupantId = ReturnType<typeof toSimOccupantId>

/** `vehicleId` and `occupant` travel together everywhere below — bundled so neither `decideVehicleAction` nor `writeVehicleAction` needs a fourth parameter. */
type VehicleActionTarget = { readonly occupant: SimOccupantId; readonly vehicleId: SimVehicleId }

/** Accept/reject only — see `applyVehicle`'s doc comment for why this runs before `session.execute`, not after. */
const decideVehicleAction = (action: MountAction, target: Vehicle | undefined, who: VehicleActionTarget): CommandDecision => {
  if (target === undefined) {
    return { accepted: false, reason: 'resource-not-found' }
  }
  if (action === 'mount') {
    if (target.occupant === undefined) {
      return { accepted: true }
    }
    return { accepted: false, reason: 'vehicle-occupied' }
  }
  if (target.occupant === who.occupant) {
    return { accepted: true }
  }
  return { accepted: false, reason: 'not-mounted' }
}

/** The write half of `mount`/`dismount` — `Effect.ignore` is deliberate, see `applyVehicle`'s doc comment. */
const writeVehicleAction = (
  vehicles: Pick<VehicleServiceApi, 'dismount' | 'mount' | 'vehicles'>,
  action: MountAction,
  who: VehicleActionTarget,
): Effect.Effect<void> => {
  if (action === 'mount') {
    return vehicles.mount(who.vehicleId, who.occupant).pipe(Effect.ignore)
  }
  return vehicles.dismount(who.vehicleId, who.occupant).pipe(Effect.ignore)
}

/**
 * `VehicleCommand`'s `'mount'` and `'dismount'` write through
 * `VehicleServiceApi`. Unlike vitals and inventory, mount/dismount DO have a
 * session-level accept/reject decision — `CommandRejectionReason` already
 * carries `'not-mounted'` and `'vehicle-occupied'` literals for exactly this
 * (protocol.ts), so this applier reads the roster BEFORE calling `decide`,
 * same reason `applyEntityPickup` reads `find` first: the decision has to be
 * synchronous and any mc-sim read it needs has to resolve before `execute`.
 *
 * The read-then-write has the same TOCTOU gap `applyEntityPickup`'s header
 * documents for `despawn` — another peer could mount the same vehicle
 * between the read and the write — and this applier resolves it the same
 * way: the accept/reject decision is already recorded in the ledger by the
 * time `mount`/`dismount` runs, and `Effect.ignore` on that call is
 * deliberate, not a swallowed bug. `VehicleService`'s own `Ref.modify` is
 * still the arbitration primitive for who actually ends up the occupant;
 * this applier's job ends at calling it, matching `applyEntityPickup`'s
 * despawn.
 *
 * `'move'` has no service shape to write through without inventing vehicle
 * physics — see `VEHICLE_MOVE_UNAVAILABLE_REASON`.
 */
const applyVehicle =
  (
    session: AuthoritativeSession,
    vehiclesFor: (player: PlayerId) => Pick<VehicleServiceApi, 'dismount' | 'mount' | 'vehicles'> | undefined,
  ) =>
  (command: VehicleCommand): Effect.Effect<CommandApplicationOutcome> => {
    const { action } = command
    if (action !== 'mount' && action !== 'dismount') {
      return Effect.succeed(commandNotWritable(command, VEHICLE_MOVE_UNAVAILABLE_REASON))
    }

    const vehicles = vehiclesFor(command.player)
    if (vehicles === undefined) {
      return Effect.succeed(session.execute(command, () => ({ accepted: false, reason: 'unauthorized-player' })))
    }

    return Effect.gen(function* () {
      const who: VehicleActionTarget = { occupant: toSimOccupantId(command.player), vehicleId: toSimVehicleId(command.entityId) }
      const roster = yield* vehicles.vehicles
      const target = roster.find((vehicle) => vehicle.id === who.vehicleId)
      let decided = false
      const decide = (): CommandDecision => {
        decided = true
        return decideVehicleAction(action, target, who)
      }
      const result = session.execute(command, decide)
      if (decided && result._tag === 'AuthoritativeCommandAccepted') {
        yield* writeVehicleAction(vehicles, action, who)
      }
      return result
    })
  }

/**
 * Every `AuthoritativeCommand` tag this file does NOT wire, and why —
 * verified against mc-sim's published `application/` services (`git ls-tree
 * origin/main -- src/application` on `@nerima-games/mc-sim`), not guessed.
 * `Record<..., string>` over the exact remaining tag union means adding a
 * twenty-first command tag without adding a reason here fails to compile,
 * the same exhaustiveness discipline `protocol.ts`'s tagged union already
 * uses.
 */
const UNAVAILABLE_REASONS: Record<
  Exclude<AuthoritativeCommand['_tag'], 'EntityPickupCommand' | 'PlayerInventoryCommand' | 'PlayerVitalsCommand' | 'VehicleCommand'>,
  string
> = {
  BowUseCommand: 'mc-sim has no projectile-charge application service.',
  BucketUseCommand: 'mc-sim has no fluid pickup/placement application service.',
  ContainerCommand: 'mc-sim has no shared-container application service; InventoryService models one player, not a world-owned container.',
  EndPortalUseCommand: 'mc-sim has no portal-traversal application service.',
  EnderPearlCommand: 'mc-sim has no projectile/teleport application service.',
  EntityAttackCommand:
    "EntityManagerApi.sweep is the only way to change an existing entity, and it takes a step function typed over the host's own entity-behaviour type parameter (see mc-sim's entity-manager.ts). This package does not know that type and there is no behaviour-agnostic 'damage entity by id' method to call instead.",
  FishingCommand: 'mc-sim has no fishing application service.',
  FurnaceCommand: 'mc-sim has no furnace/smelting application service, though domain/smelting.ts exists for the pure rules.',
  IgniteTntCommand: 'domain/primed-tnt.ts exists but is not wrapped by an application service.',
  InsertEyeIntoEndPortalFrameCommand: 'mc-sim has no end-portal-frame application service.',
  NetherPortalUseCommand: 'mc-sim has no portal-traversal application service.',
  ThrowEyeOfEnderCommand: 'mc-sim has no stronghold/eye-of-ender application service.',
  ToggleLeverCommand: 'lever/redstone device state belongs to mx-redstone, not mc-sim.',
  VehicleUseCommand:
    "VehicleUseCommand's wire shape is CommandHeader only — protocol.ts's definition carries no entityId and no action, unlike VehicleCommand. There is no vehicle to act on in the message at all, so no amount of occupant-id/vehicle-id plumbing wires this one; VehicleCommand's mount/dismount now write through (see applyVehicle) precisely because that command does carry an entityId.",
  VillagerTradeCommand: 'mc-sim has no villager/trade application service.',
  WorldTimeWeatherCommand:
    "'set-time' sends a raw non-negative tick integer, but TimeServiceApi.setTimeOfDay wants a [0,1) fraction, and the tick-per-second conversion constant lives in domain/time-of-day.ts, which mc-sim's index.ts does not re-export. 'set-weather' sends a bare 'clear'|'rain'|'thunder' literal, but WeatherServiceApi.applyTransition takes a complete WeatherState already computed by gameplay rules. Neither sub-case has a clean write-through today.",
}

/**
 * Apply one accepted-or-rejected `AuthoritativeCommand` by writing it
 * through `session` and, for the tags `WorldWriteServices` covers, through
 * mc-sim. Every other tag returns `CommandNotWritable` rather than reaching
 * into a rules module — see `UNAVAILABLE_REASONS`.
 */
export const applyAuthoritativeCommand =
  <Behaviour>(session: AuthoritativeSession, services: WorldWriteServices<Behaviour>) =>
  (command: AuthoritativeCommand): Effect.Effect<CommandApplicationOutcome> => {
    switch (command._tag) {
      case 'EntityPickupCommand':
        return applyEntityPickup(session, services.entities)(command)
      case 'PlayerInventoryCommand':
        return applyPlayerInventory(session, services.inventoryFor, services.hotbarFor)(command)
      case 'PlayerVitalsCommand':
        return applyPlayerVitals(session, services.vitalsFor)(command)
      case 'VehicleCommand':
        return applyVehicle(session, services.vehiclesFor)(command)
      default:
        return Effect.succeed({
          _tag: 'CommandNotWritable',
          commandId: command.commandId,
          commandTag: command._tag,
          reason: UNAVAILABLE_REASONS[command._tag],
        })
    }
  }
