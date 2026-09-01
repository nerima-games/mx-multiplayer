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
 * Only two of the twenty `AuthoritativeCommand` tags are wired here —
 * `EntityPickupCommand` and `PlayerVitalsCommand` — because those are the
 * ones with an mc-sim service whose shape needs no game-rule table this
 * package would have to invent to use it. `UNAVAILABLE_REASONS` below is the
 * verified map of why every other tag is not: some have no mc-sim service at
 * all, some have one shaped for a single player where multiplayer needs a
 * per-player registry this file does not yet build, and one (`'eat'`, inside
 * `PlayerVitalsCommand`) needs an item→food-value table that belongs to
 * mx-gameplay, not here.
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
import { type EntityManagerApi, type VitalsServiceApi, EntityId as toSimEntityId } from '@nerima-games/mc-sim'
import { Effect } from 'effect'

/**
 * What a host must supply for the two command families this file writes
 * through. `entities` is narrowed to exactly the two methods used — `find`
 * and `despawn` — so this file does not depend on the host's entity
 * behaviour type beyond what `EntityManagerApi` already keeps agnostic to it
 * in those two signatures (see mc-sim's `entity-manager.ts`).
 *
 * `vitalsFor` is a lookup rather than a single `VitalsServiceApi`, because
 * mc-sim's `VitalsService` is one `Context.Tag` per provide (one player's
 * vitals), not a per-player registry like `EntityManagerApi` is generic
 * over. A multiplayer host holds N players; this file does not decide how
 * the host indexes them, only that it can be asked for one by `PlayerId`.
 */
export type WorldWriteServices<Behaviour> = {
  readonly entities: Pick<EntityManagerApi<Behaviour>, 'find' | 'despawn'>
  readonly vitalsFor: (player: PlayerId) => VitalsServiceApi | undefined
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
type PlayerVitalsCommand = Extract<AuthoritativeCommand, { readonly _tag: 'PlayerVitalsCommand' }>

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
  Exclude<AuthoritativeCommand['_tag'], 'EntityPickupCommand' | 'PlayerVitalsCommand'>,
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
  PlayerInventoryCommand:
    "mc-sim exposes InventoryService, but as one Context.Tag instance per provide, the same single-player shape VitalsService has. Wiring it needs the same host-supplied per-player lookup WorldWriteServices adds for vitals, plus a mapping from PlayerInventoryAction's select-slot/move-item/swap-items/sort variants to InventoryServiceApi's methods — not attempted this session.",
  ThrowEyeOfEnderCommand: 'mc-sim has no stronghold/eye-of-ender application service.',
  ToggleLeverCommand: 'lever/redstone device state belongs to mx-redstone, not mc-sim.',
  VehicleCommand:
    'mc-sim exposes VehicleService, but wiring mount/dismount/move needs occupant-id and vehicle-id plumbing this session did not design — left for a follow-up alongside PlayerInventoryCommand.',
  VehicleUseCommand:
    'mc-sim exposes VehicleService, but wiring mount/dismount needs occupant-id and vehicle-id plumbing this session did not design — left for a follow-up alongside PlayerInventoryCommand.',
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
      case 'PlayerVitalsCommand':
        return applyPlayerVitals(session, services.vitalsFor)(command)
      default:
        return Effect.succeed({
          _tag: 'CommandNotWritable',
          commandId: command.commandId,
          commandTag: command._tag,
          reason: UNAVAILABLE_REASONS[command._tag],
        })
    }
  }
