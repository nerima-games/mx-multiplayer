import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Schema } from 'effect'
import { DimensionRevisionSchema, itemIdOf, SimulationTickSchema } from '@nerima-games/mc-kernel'
import { applyAuthoritativeCommand, AuthoritativeSession, CommandId, EntityId, PlayerId, WorldId, type AuthoritativeCommand, type AuthoritativeSnapshot, type CommandUnsupportedReason, type WorldWriteServices } from '../src/index'

const world = WorldId.make('overworld')
const alice = PlayerId.make('alice')
const bob = PlayerId.make('bob')
const commandHeader = (id: string) => ({ commandId: CommandId.make(id), expectedRevision: 0, player: alice, world })
const intentContext = (identity: symbol) => ({
  identity,
  expectedDimensionRevision: Schema.decodeUnknownSync(DimensionRevisionSchema)(3),
  targetTick: Schema.decodeUnknownSync(SimulationTickSchema)(12),
})

const snapshot: AuthoritativeSnapshot = {
  _tag: 'AuthoritativeSnapshot',
  containers: [],
  furnaces: [],
  inventories: [],
  revision: 0,
  timeWeather: { timeOfDay: 0, weather: 'clear' },
  villagerTrades: [],
  vitals: [],
  world,
}

type TestCommand<Tag extends AuthoritativeCommand['_tag']> = Extract<AuthoritativeCommand, { readonly _tag: Tag }>

function command(tag: 'EntityPickupCommand', commandId: string, player?: typeof alice, expectedRevision?: number): TestCommand<'EntityPickupCommand'>
function command(tag: 'PlayerInventoryCommand', commandId: string, player?: typeof alice, expectedRevision?: number): TestCommand<'PlayerInventoryCommand'>
function command(tag: 'PlayerVitalsCommand', commandId: string, player?: typeof alice, expectedRevision?: number): TestCommand<'PlayerVitalsCommand'>
function command(tag: 'VehicleCommand', commandId: string, player?: typeof alice, expectedRevision?: number): TestCommand<'VehicleCommand'>
function command(tag: 'BowUseCommand', commandId: string, player?: typeof alice, expectedRevision?: number): TestCommand<'BowUseCommand'>
function command(tag: 'FishingCommand', commandId: string, player?: typeof alice, expectedRevision?: number): TestCommand<'FishingCommand'>
function command(
  tag: 'EntityPickupCommand' | 'PlayerInventoryCommand' | 'PlayerVitalsCommand' | 'VehicleCommand' | 'BowUseCommand' | 'FishingCommand',
  commandId: string,
  player = alice,
  expectedRevision = 0,
): AuthoritativeCommand {
  const header = { commandId: CommandId.make(commandId), expectedRevision, player, world }
  switch (tag) {
    case 'EntityPickupCommand':
      return { ...header, _tag: tag, entityId: EntityId.make('entity-1') }
    case 'PlayerInventoryCommand':
      return { ...header, _tag: tag, action: { _tag: 'select-slot', slot: 1 } }
    case 'PlayerVitalsCommand':
      return { ...header, _tag: tag, action: 'respawn' }
    case 'VehicleCommand':
      return { ...header, _tag: tag, action: 'mount', entityId: EntityId.make('vehicle-1') }
    case 'BowUseCommand':
      return { ...header, _tag: tag, action: 'start' }
    case 'FishingCommand':
      return { ...header, _tag: tag, action: 'cast' }
  }
}

const makeHarness = () => {
  const revision = 0
  const state = { value: 17 }
  const deltas: Array<unknown> = []
  let lookups = 0
  let mutations = 0
  const unexpectedMutation = () => {
    mutations += 1
    return Effect.die(new Error('unexpected simulation mutation'))
  }
  const services: WorldWriteServices<never> = {
    entities: {
      find: () => {
        lookups += 1
        return unexpectedMutation()
      },
      despawn: unexpectedMutation,
    },
    vitalsFor: () => {
      lookups += 1
      return undefined
    },
    inventoryFor: () => {
      lookups += 1
      return undefined
    },
    hotbarFor: () => {
      lookups += 1
      return undefined
    },
    vehiclesFor: () => {
      lookups += 1
      return undefined
    },
  }

  const session = new AuthoritativeSession((requestedWorld) => requestedWorld === world ? revision : undefined)
  session.restore(snapshot)
  const identity = session.connect(alice, world)

  return {
    session,
    identity,
    services,
    state,
    deltas,
    get revision() {
      return revision
    },
    get lookups() {
      return lookups
    },
    get mutations() {
      return mutations
    },
  }
}

describe('applyAuthoritativeCommand', () => {
  it('returns canonical C2 intents for every exactly representable command without changing owner revision', async () => {
    const harness = makeHarness()
    const commands: ReadonlyArray<{ readonly command: AuthoritativeCommand; readonly payload: unknown }> = [
      {
        command: { ...command('PlayerVitalsCommand', 'eat'), action: { _tag: 'eat', item: 'apple' } },
        payload: { _tag: 'UseItem', actor: alice, item: itemIdOf('apple') },
      },
      {
        command: {
          _tag: 'VillagerTradeCommand',
          action: 'execute-trade',
          commandId: CommandId.make('trade'),
          expectedRevision: 0,
          offerId: 'offer:one',
          player: alice,
          villagerId: 'villager:one',
          world,
        },
        payload: { _tag: 'TradeVillager', actor: alice, villager: 'villager:one', offerId: 'offer:one' },
      },
      { command: command('BowUseCommand', 'bow-draw'), payload: { _tag: 'BowAction', actor: alice, action: 'draw' } },
      { command: { ...command('BowUseCommand', 'bow-release'), action: 'release' }, payload: { _tag: 'BowAction', actor: alice, action: 'release' } },
      { command: command('FishingCommand', 'fishing-cast'), payload: { _tag: 'FishingAction', actor: alice, action: 'cast' } },
      { command: { ...command('FishingCommand', 'fishing-reel'), action: 'reel' }, payload: { _tag: 'FishingAction', actor: alice, action: 'reel' } },
      { command: command('VehicleCommand', 'vehicle-mount'), payload: { _tag: 'VehicleAction', actor: alice, vehicle: 'vehicle-1', action: 'mount' } },
      { command: { ...command('VehicleCommand', 'vehicle-dismount'), action: 'dismount' }, payload: { _tag: 'VehicleAction', actor: alice, vehicle: 'vehicle-1', action: 'dismount' } },
      {
        command: { ...command('VehicleCommand', 'vehicle-forward'), action: { _tag: 'move', direction: 'forward' } },
        payload: { _tag: 'VehicleControl', actor: alice, vehicle: 'vehicle-1', throttle: 1, steering: 0 },
      },
      {
        command: { ...command('VehicleCommand', 'vehicle-backward'), action: { _tag: 'move', direction: 'backward' } },
        payload: { _tag: 'VehicleControl', actor: alice, vehicle: 'vehicle-1', throttle: -1, steering: 0 },
      },
    ]

    const results = await Promise.all(
      commands.map(async (received) => ({
        received: received.command,
        payload: received.payload,
        result: await Effect.runPromise(
          applyAuthoritativeCommand(harness.session, harness.services, intentContext(harness.identity))(received.command),
        ),
      })),
    )
    for (const { received, payload, result } of results) {
      expect(result).toMatchObject({
        _tag: 'AuthoritativeCommandIntentAccepted',
        commandId: received.commandId,
        intent: {
          expectedDimensionRevision: 3,
          expectedRevision: 0,
          id: received.commandId,
          payload,
          source: 'network',
          targetTick: 12,
        },
      })
    }

    expect(harness.state).toStrictEqual({ value: 17 })
    expect(harness.revision).toBe(0)
    expect(harness.deltas).toHaveLength(0)
    expect(harness.lookups).toBe(0)
    expect(harness.mutations).toBe(0)
  })

  it('returns a cached intent on identical replay and rejects reuse of its command id with a different payload', async () => {
    const harness = makeHarness()
    const received = { ...command('BowUseCommand', 'same-id'), action: 'release' as const }
    const apply = applyAuthoritativeCommand(harness.session, harness.services, intentContext(harness.identity))

    const first = await Effect.runPromise(apply(received))
    const replay = await Effect.runPromise(apply(received))
    const conflict = await Effect.runPromise(apply({ ...received, action: 'start' }))

    expect(first).toMatchObject({ _tag: 'AuthoritativeCommandIntentAccepted', intent: { payload: { _tag: 'BowAction', action: 'release' } } })
    expect(replay).toMatchObject({ _tag: 'AuthoritativeCommandIntentReplayed', commandId: received.commandId })
    expect(replay).not.toHaveProperty('intent')
    expect(conflict).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'invalid-command' })
    expect(harness.revision).toBe(0)
    expect(harness.lookups).toBe(0)
    expect(harness.mutations).toBe(0)
  })

  it('returns a typed unsupported result only when no C2 payload preserves the command', async () => {
    const harness = makeHarness()
    const unsupported: Array<{ readonly command: AuthoritativeCommand; readonly reason: CommandUnsupportedReason }> = [
      { command: command('EntityPickupCommand', 'pickup'), reason: 'no-matching-c2-intent-payload' },
      { command: command('PlayerInventoryCommand', 'inventory'), reason: 'no-matching-c2-intent-payload' },
      { command: command('PlayerVitalsCommand', 'respawn'), reason: 'no-matching-c2-intent-payload' },
      {
        command: { ...command('PlayerVitalsCommand', 'activity'), action: { _tag: 'activity', activity: 'attack', amount: 50 } },
        reason: 'intent-payload-does-not-preserve-command',
      },
      {
        command: { ...commandHeader('world-time'), _tag: 'WorldTimeWeatherCommand', action: { _tag: 'set-time', timeOfDay: 6000 } },
        reason: 'no-matching-c2-intent-payload',
      },
      {
        command: { ...commandHeader('container'), _tag: 'ContainerCommand', action: { _tag: 'open' }, containerId: 'chest:one' },
        reason: 'no-matching-c2-intent-payload',
      },
      {
        command: {
          ...commandHeader('furnace'),
          _tag: 'FurnaceCommand',
          action: {
            _tag: 'take-output',
            count: 1,
            destination: { _tag: 'player-slot', slot: 0 },
            source: { _tag: 'furnace-slot', slot: 'output' },
          },
          furnaceId: 'furnace:one',
        },
        reason: 'no-matching-c2-intent-payload',
      },
      {
        command: { ...command('EntityPickupCommand', 'attack'), _tag: 'EntityAttackCommand' },
        reason: 'intent-payload-does-not-preserve-command',
      },
      {
        command: { ...commandHeader('ignite-tnt'), _tag: 'IgniteTntCommand', at: { x: 0, y: 64, z: 0 } },
        reason: 'no-matching-c2-intent-payload',
      },
      {
        command: { ...commandHeader('end-portal'), _tag: 'EndPortalUseCommand', portal: { x: 0, y: 64, z: 0 } },
        reason: 'no-matching-c2-intent-payload',
      },
      { command: { ...commandHeader('throw-eye'), _tag: 'ThrowEyeOfEnderCommand' }, reason: 'no-matching-c2-intent-payload' },
      {
        command: { ...commandHeader('insert-eye'), _tag: 'InsertEyeIntoEndPortalFrameCommand', frame: { x: 0, y: 64, z: 0 } },
        reason: 'no-matching-c2-intent-payload',
      },
      {
        command: { ...commandHeader('nether-portal'), _tag: 'NetherPortalUseCommand', portal: { x: 0, y: 64, z: 0 } },
        reason: 'no-matching-c2-intent-payload',
      },
      {
        command: { ...commandHeader('toggle-lever'), _tag: 'ToggleLeverCommand', lever: { x: 0, y: 64, z: 0 } },
        reason: 'no-matching-c2-intent-payload',
      },
      {
        command: {
          _tag: 'EnderPearlCommand',
          commandId: CommandId.make('ender-pearl'),
          expectedRevision: 0,
          player: alice,
          world,
        },
        reason: 'intent-payload-does-not-preserve-command',
      },
      { command: { ...commandHeader('bucket'), _tag: 'BucketUseCommand' }, reason: 'no-matching-c2-intent-payload' },
      { command: { ...commandHeader('vehicle-use'), _tag: 'VehicleUseCommand' }, reason: 'no-matching-c2-intent-payload' },
    ]

    for (const activity of ['walk', 'swim', 'jump', 'attack', 'mine'] as const) {
      unsupported.push({
        command: {
          ...command('PlayerVitalsCommand', `activity-${activity}`),
          action: { _tag: 'activity', activity, amount: 50 },
        },
        reason: 'intent-payload-does-not-preserve-command',
      })
    }

    const results = await Promise.all(unsupported.map(async ({ command: received, reason }) => ({
      received,
      reason,
      result: await Effect.runPromise(
        applyAuthoritativeCommand(harness.session, harness.services, intentContext(harness.identity))(received),
      ),
    })))
    for (const { received, reason, result } of results) {
      expect(result).toMatchObject({
        _tag: 'CommandUnsupported',
        commandId: received.commandId,
        commandTag: received._tag,
        reason,
      })
    }

    expect(harness.revision).toBe(0)
    expect(harness.lookups).toBe(0)
    expect(harness.mutations).toBe(0)
  })

  it('rejects a vitals item name absent from mc-kernel ItemType before returning an intent', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromiseExit(
      applyAuthoritativeCommand(harness.session, harness.services, intentContext(harness.identity))({
        ...command('PlayerVitalsCommand', 'unknown-food'),
        action: { _tag: 'eat', item: 'not-an-item-type' },
      }),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Schema.isSchemaError(Cause.squash(result.cause))).toBe(true)
    }
    expect(harness.revision).toBe(0)
    expect(harness.lookups).toBe(0)
    expect(harness.mutations).toBe(0)
  })

  it('rejects stale revisions before any service lookup and leaves state, revision, and deltas unchanged', async () => {
    const harness = makeHarness()
    const beforeState = { ...harness.state }
    const beforeDeltas = [...harness.deltas]
    const result = await Effect.runPromise(
      applyAuthoritativeCommand(harness.session, harness.services, intentContext(harness.identity))(
        command('PlayerInventoryCommand', 'stale', alice, 1),
      ),
    )

    expect(result).toMatchObject({
      _tag: 'AuthoritativeCommandRejected',
      reason: 'stale-revision',
      resyncRequired: true,
      revision: 0,
    })
    expect(harness.state).toStrictEqual(beforeState)
    expect(harness.revision).toBe(0)
    expect(harness.deltas).toStrictEqual(beforeDeltas)
    expect(harness.lookups).toBe(0)
    expect(harness.mutations).toBe(0)
  })

  it('rejects a player or world claim that does not match the server-issued connection identity', async () => {
    const harness = makeHarness()
    const wrongPlayer = await Effect.runPromise(
      applyAuthoritativeCommand(harness.session, harness.services, intentContext(harness.identity))(
        command('VehicleCommand', 'wrong-player', bob),
      ),
    )
    const unissuedIdentity = Symbol('unissued')
    const unissued = await Effect.runPromise(
      applyAuthoritativeCommand(harness.session, harness.services, intentContext(unissuedIdentity))(
        command('EntityPickupCommand', 'unissued'),
      ),
    )

    expect(wrongPlayer).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'unauthorized-player' })
    expect(unissued).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'unauthorized-player' })
    expect(harness.state).toStrictEqual({ value: 17 })
    expect(harness.revision).toBe(0)
    expect(harness.deltas).toHaveLength(0)
    expect(harness.lookups).toBe(0)
    expect(harness.mutations).toBe(0)
  })

  it('requires an initialized WCC-backed session before returning an unsupported outcome', async () => {
    let revision = 0
    const session = new AuthoritativeSession(() => revision)
    const identity = session.connect(alice, world)
    const harness = makeHarness()
    const result = await Effect.runPromise(
      applyAuthoritativeCommand(session, harness.services, intentContext(identity))(command('EntityPickupCommand', 'uninitialized')),
    )

    expect(result).toMatchObject({
      _tag: 'AuthoritativeCommandRejected',
      reason: 'snapshot-required',
      resyncRequired: true,
    })
    expect(harness.lookups).toBe(0)
    expect(harness.mutations).toBe(0)
    revision = 0
  })

  it('rejects malformed runtime commands with a typed schema failure before service lookup', async () => {
    const harness = makeHarness()
    const malformed = { ...command('PlayerInventoryCommand', 'malformed'), extra: true }
    const result = await Effect.runPromiseExit(
      applyAuthoritativeCommand(harness.session, harness.services, intentContext(harness.identity))(malformed),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Schema.isSchemaError(Cause.squash(result.cause))).toBe(true)
    }
    expect(harness.state).toStrictEqual({ value: 17 })
    expect(harness.revision).toBe(0)
    expect(harness.deltas).toHaveLength(0)
    expect(harness.lookups).toBe(0)
    expect(harness.mutations).toBe(0)
  })
})
