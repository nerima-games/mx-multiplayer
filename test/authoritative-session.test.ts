import { describe, expect, it } from '@effect/vitest'
import { Either, Schema, SchemaAST } from 'effect'
import {
  AuthoritativeCommand,
  AuthoritativeEntityState,
  AuthoritativeSession,
  AuthoritativeSnapshot,
  CommandId,
  PlayerId,
  PlayerInventoryAction,
  WorldId,
} from '../src/index'

const world = WorldId.make('overworld')
const player = PlayerId.make('alice')
const snapshot: AuthoritativeSnapshot = {
  _tag: 'AuthoritativeSnapshot',
  containers: [],
  furnaces: [],
  inventories: [{ player, state: { slots: [{ item: 'stone', count: 2 }], selectedSlot: 0 } }],
  revision: 4,
  timeWeather: { timeOfDay: 6000, weather: 'clear' },
  villagerTrades: [],
  vitals: [{ player, state: { health: 20, hunger: 20, experience: 0 } }],
  world,
}

const command = (id: string, expectedRevision = 4): Extract<AuthoritativeCommand, { readonly _tag: 'PlayerInventoryCommand' }> => ({
  _tag: 'PlayerInventoryCommand',
  action: { _tag: 'select-slot', slot: 0 },
  commandId: CommandId.make(id),
  expectedRevision,
  player,
  world,
})

describe('authoritative protocol schemas', () => {
  it('defines each authoritative entity and inventory action variant once', () => {
    const entityStateAst = AuthoritativeEntityState.ast
    const inventoryActionAst = PlayerInventoryAction.ast

    expect(SchemaAST.isUnion(entityStateAst)).toBe(true)
    expect(SchemaAST.isUnion(inventoryActionAst)).toBe(true)
    if (!SchemaAST.isUnion(entityStateAst) || !SchemaAST.isUnion(inventoryActionAst)) {
      throw new Error('authoritative schemas must remain unions')
    }

    expect(entityStateAst.types).toHaveLength(5)
    expect(inventoryActionAst.types).toHaveLength(6)
  })

  it('decodes complete reconnect snapshots and every command domain', () => {
    expect(Either.isRight(Schema.decodeUnknownEither(AuthoritativeSnapshot)(snapshot))).toBe(true)

    const commands: ReadonlyArray<AuthoritativeCommand> = [
      command('inventory'),
      { ...command('swap-inventory'), action: { _tag: 'swap-items', destination: 1, source: 0 } },
      { ...command('vitals'), _tag: 'PlayerVitalsCommand', action: 'respawn' },
      { ...command('ender-pearl'), _tag: 'EnderPearlCommand' },
      { ...command('bucket'), _tag: 'BucketUseCommand' },
      { ...command('vehicle-use'), _tag: 'VehicleUseCommand' },
      { ...command('fishing'), _tag: 'FishingCommand', action: 'cast' },
      { ...command('time'), _tag: 'WorldTimeWeatherCommand', action: { _tag: 'set-time', timeOfDay: 6000 } },
      { ...command('container'), _tag: 'ContainerCommand', action: { _tag: 'open' }, containerId: 'chest:1' },
      { ...command('furnace'), _tag: 'FurnaceCommand', action: { _tag: 'take-output', count: 1, destination: { _tag: 'player-slot', slot: 0 }, source: { _tag: 'furnace-slot', slot: 'output' } }, furnaceId: 'furnace:1' },
      {
        ...command('trade'),
        _tag: 'VillagerTradeCommand',
        action: 'execute-trade',
        offerId: 'offer:1',
        villagerId: 'villager:1',
      },
    ]
    for (const value of commands) {
      expect(Either.isRight(Schema.decodeUnknownEither(AuthoritativeCommand)(value))).toBe(true)
    }
  })

  it('decodes optional hostile lifecycle state without requiring it from older peers', () => {
    const entity: AuthoritativeEntityState = {
      _tag: 'living',
      at: { x: 0, y: 64, z: 0 },
      entityId: 'zombie-1' as AuthoritativeEntityState['entityId'],
      entityType: 'zombie',
      health: 20,
      maxHealth: 20,
      mobState: {
        ageTicks: 600,
        attackCooldownSecs: 0,
        motionPhase: 0,
        named: true,
        persistent: true,
        provoked: false,
        tamed: true,
      },
    }
    expect(Either.isRight(Schema.decodeUnknownEither(AuthoritativeEntityState)(entity))).toBe(true)
  })

  it('rejects malformed authoritative values', () => {
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(AuthoritativeSnapshot)({ ...snapshot, revision: -1 }),
      ),
    ).toBe(true)
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(AuthoritativeCommand)({ ...command('valid'), commandId: '' }),
      ),
    ).toBe(true)

    const invalidCommands: ReadonlyArray<unknown> = [
      { ...command('old-action'), action: 'select-slot' },
      { ...command('missing-slot'), action: { _tag: 'select-slot' } },
      { ...command('zero-count'), action: { _tag: 'move-item', count: 0, destination: 1, source: 0 } },
      { ...command('swap-missing-destination'), action: { _tag: 'swap-items', source: 0 } },
      {
        ...command('wrong-weather-payload'),
        _tag: 'WorldTimeWeatherCommand',
        action: { _tag: 'set-weather', timeOfDay: 6000 },
      },
      {
        ...command('same-side-container'),
        _tag: 'ContainerCommand',
        action: { _tag: 'move-item', count: 1, destination: { _tag: 'container-slot', slot: 1 }, source: { _tag: 'container-slot', slot: 0 } },
        containerId: 'chest:1',
      },
    ]
    for (const value of invalidCommands) {
      expect(Either.isLeft(Schema.decodeUnknownEither(AuthoritativeCommand)(value))).toBe(true)
    }
  })
})

describe('authoritative command session', () => {
  it('requires a full snapshot after connection and reconnect', () => {
    const subject = new AuthoritativeSession()
    expect(subject.execute(command('before'), () => ({ accepted: true }))).toMatchObject({
      _tag: 'AuthoritativeCommandRejected',
      reason: 'snapshot-required',
      resyncRequired: true,
    })
    subject.restore(snapshot)
    expect(subject.execute(command('after'), () => ({ accepted: true }))).toMatchObject({
      _tag: 'AuthoritativeCommandAccepted',
      revision: 5,
    })
    subject.disconnect(world)
    expect(subject.execute(command('reconnect', 5), () => ({ accepted: true }))).toMatchObject({
      reason: 'snapshot-required',
    })
  })

  it('clears every world when disconnect is called with no world, unlike a targeted disconnect', () => {
    const subject = new AuthoritativeSession()
    const nether = WorldId.make('nether')
    subject.restore(snapshot)
    subject.restore({ ...snapshot, revision: 7, world: nether })

    subject.disconnect()

    expect(subject.revision(world)).toBeUndefined()
    expect(subject.revision(nether)).toBeUndefined()
    expect(
      subject.execute(command('after-clear-all', 4), () => ({ accepted: true })),
    ).toMatchObject({ reason: 'snapshot-required', resyncRequired: true })
  })

  it('returns the cached result for duplicate command ids without reapplying', () => {
    const subject = new AuthoritativeSession()
    subject.restore(snapshot)
    let applications = 0
    const apply = () => {
      applications += 1
      return { accepted: true } as const
    }
    const first = subject.execute(command('same'), apply)
    expect(subject.execute(command('same'), apply)).toStrictEqual(first)
    expect(applications).toBe(1)
    expect(subject.revision(world)).toBe(5)
  })

  it('does not let one player command id suppress another player command', () => {
    const subject = new AuthoritativeSession()
    subject.restore(snapshot)
    let applications = 0
    const apply = () => {
      applications += 1
      return { accepted: true } as const
    }

    subject.execute(command('same-id'), apply)
    const bobCommand = {
      ...command('same-id', 5),
      player: PlayerId.make('bob'),
    }
    expect(subject.execute(bobCommand, apply)).toMatchObject({
      _tag: 'AuthoritativeCommandAccepted',
      revision: 6,
    })
    expect(applications).toBe(2)
    expect(subject.revision(world)).toBe(6)
  })

  it('does not let a command id in one world suppress the same player in another world', () => {
    const subject = new AuthoritativeSession()
    const nether = WorldId.make('nether')
    subject.restore(snapshot)
    subject.restore({ ...snapshot, revision: 7, world: nether })
    let applications = 0
    const apply = () => {
      applications += 1
      return { accepted: true } as const
    }

    subject.execute(command('same-id'), apply)
    const netherCommand = { ...command('same-id', 7), world: nether }
    expect(subject.execute(netherCommand, apply)).toMatchObject({
      _tag: 'AuthoritativeCommandAccepted',
      revision: 8,
      world: nether,
    })
    expect(applications).toBe(2)
    expect(subject.revision(world)).toBe(5)
    expect(subject.revision(nether)).toBe(8)
  })

  it('rejects stale revisions without invoking game rules or advancing state', () => {
    const subject = new AuthoritativeSession()
    subject.restore(snapshot)
    let invoked = false
    expect(
      subject.execute(command('stale', 3), () => {
        invoked = true
        return { accepted: true }
      }),
    ).toMatchObject({ reason: 'stale-revision', resyncRequired: true, revision: 4 })
    expect(invoked).toBe(false)
    expect(subject.revision(world)).toBe(4)
  })

  it('caches domain rejections without advancing the revision', () => {
    const subject = new AuthoritativeSession()
    subject.restore(snapshot)
    const result = subject.execute(command('denied'), () => ({
      accepted: false,
      reason: 'insufficient-items',
    }))
    expect(result).toMatchObject({ reason: 'insufficient-items', resyncRequired: false })
    expect(subject.execute(command('denied'), () => ({ accepted: true }))).toStrictEqual(result)
    expect(subject.revision(world)).toBe(4)
  })

  it('passes an executable transfer payload unchanged to game rules', () => {
    const subject = new AuthoritativeSession()
    subject.restore(snapshot)
    const transfer: AuthoritativeCommand = {
      ...command('transfer'),
      _tag: 'ContainerCommand',
      action: {
        _tag: 'move-item',
        count: 2,
        destination: { _tag: 'container-slot', slot: 3 },
        source: { _tag: 'player-slot', slot: 0 },
      },
      containerId: 'chest:1',
    }

    const result = subject.execute(transfer, (received) => {
      expect(received).toStrictEqual(transfer)
      if (received._tag !== 'ContainerCommand' || received.action._tag !== 'move-item') {
        return { accepted: false, reason: 'invalid-command' }
      }
      expect(received.action.source).toStrictEqual({ _tag: 'player-slot', slot: 0 })
      expect(received.action.destination).toStrictEqual({ _tag: 'container-slot', slot: 3 })
      expect(received.action.count).toBe(2)
      return { accepted: true }
    })

    expect(result).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 5 })
  })
})
