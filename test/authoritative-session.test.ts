import { describe, expect, it } from '@effect/vitest'
import { Either, Schema } from 'effect'
import {
  AuthoritativeCommand,
  AuthoritativeEntityState,
  AuthoritativeSession,
  AuthoritativeSnapshot,
  CommandId,
  PlayerId,
  WorldId,
} from '../src/index'

const world = WorldId.make('overworld')
const player = PlayerId.make('alice')
const snapshot: AuthoritativeSnapshot = {
  _tag: 'AuthoritativeSnapshot',
  world,
  revision: 4,
  inventories: [{ player, state: { slots: [{ item: 'stone', count: 2 }], selectedSlot: 0 } }],
  vitals: [{ player, state: { health: 20, hunger: 20, experience: 0 } }],
  timeWeather: { timeOfDay: 6000, weather: 'clear' },
  containers: [],
  furnaces: [],
  villagerTrades: [],
}

const command = (id: string, expectedRevision = 4): AuthoritativeCommand => ({
  _tag: 'PlayerInventoryCommand',
  commandId: CommandId.make(id),
  player,
  world,
  expectedRevision,
  action: { _tag: 'select-slot', slot: 0 },
})

describe('authoritative protocol schemas', () => {
  it('decodes complete reconnect snapshots and every command domain', () => {
    expect(Either.isRight(Schema.decodeUnknownEither(AuthoritativeSnapshot)(snapshot))).toBe(true)

    const commands: ReadonlyArray<AuthoritativeCommand> = [
      command('inventory'),
      { ...command('vitals'), _tag: 'PlayerVitalsCommand', action: 'respawn' },
      { ...command('ender-pearl'), _tag: 'EnderPearlCommand' },
      { ...command('bucket'), _tag: 'BucketUseCommand' },
      { ...command('vehicle-use'), _tag: 'VehicleUseCommand' },
      { ...command('fishing'), _tag: 'FishingCommand', action: 'cast' },
      { ...command('time'), _tag: 'WorldTimeWeatherCommand', action: { _tag: 'set-time', timeOfDay: 6000 } },
      { ...command('container'), _tag: 'ContainerCommand', containerId: 'chest:1', action: { _tag: 'open' } },
      { ...command('furnace'), _tag: 'FurnaceCommand', furnaceId: 'furnace:1', action: { _tag: 'take-output', source: { _tag: 'furnace-slot', slot: 'output' }, destination: { _tag: 'player-slot', slot: 0 }, count: 1 } },
      {
        ...command('trade'),
        _tag: 'VillagerTradeCommand',
        villagerId: 'villager:1',
        offerId: 'offer:1',
        action: 'execute-trade',
      },
    ]
    for (const value of commands) {
      expect(Either.isRight(Schema.decodeUnknownEither(AuthoritativeCommand)(value))).toBe(true)
    }
  })

  it('decodes optional hostile lifecycle state without requiring it from older peers', () => {
    const entity: AuthoritativeEntityState = {
      _tag: 'living',
      entityId: 'zombie-1' as AuthoritativeEntityState['entityId'],
      entityType: 'zombie',
      at: { x: 0, y: 64, z: 0 },
      health: 20,
      maxHealth: 20,
      mobState: {
        attackCooldownSecs: 0,
        motionPhase: 0,
        provoked: false,
        ageTicks: 600,
        persistent: true,
        named: true,
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
      { ...command('zero-count'), action: { _tag: 'move-item', source: 0, destination: 1, count: 0 } },
      {
        ...command('wrong-weather-payload'),
        _tag: 'WorldTimeWeatherCommand',
        action: { _tag: 'set-weather', timeOfDay: 6000 },
      },
      {
        ...command('same-side-container'),
        _tag: 'ContainerCommand',
        containerId: 'chest:1',
        action: { _tag: 'move-item', source: { _tag: 'container-slot', slot: 0 }, destination: { _tag: 'container-slot', slot: 1 }, count: 1 },
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

  it('rejects stale revisions without invoking game rules or advancing state', () => {
    const subject = new AuthoritativeSession()
    subject.restore(snapshot)
    let invoked = false
    expect(
      subject.execute(command('stale', 3), () => {
        invoked = true
        return { accepted: true }
      }),
    ).toMatchObject({ reason: 'stale-revision', revision: 4, resyncRequired: true })
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
      containerId: 'chest:1',
      action: {
        _tag: 'move-item',
        source: { _tag: 'player-slot', slot: 0 },
        destination: { _tag: 'container-slot', slot: 3 },
        count: 2,
      },
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
