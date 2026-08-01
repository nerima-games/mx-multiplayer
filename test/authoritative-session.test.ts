import { describe, expect, it } from '@effect/vitest'
import { Either, Schema } from 'effect'
import {
  AuthoritativeCommand,
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
  action: 'select-slot',
})

describe('authoritative protocol schemas', () => {
  it('decodes complete reconnect snapshots and every command domain', () => {
    expect(Either.isRight(Schema.decodeUnknownEither(AuthoritativeSnapshot)(snapshot))).toBe(true)

    const commands: ReadonlyArray<AuthoritativeCommand> = [
      command('inventory'),
      { ...command('vitals'), _tag: 'PlayerVitalsCommand', action: 'respawn' },
      { ...command('time'), _tag: 'WorldTimeWeatherCommand', action: 'set-time' },
      { ...command('container'), _tag: 'ContainerCommand', containerId: 'chest:1', action: 'open' },
      { ...command('furnace'), _tag: 'FurnaceCommand', furnaceId: 'furnace:1', action: 'take-output' },
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
})
