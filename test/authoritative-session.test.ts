import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { Cause, Effect, Exit, Result, Schema, SchemaAST } from 'effect'
import { IntentSchema } from '@nerima-games/mc-sim'
import {
  AuthoritativeCommand,
  AuthoritativeEntityState,
  AuthoritativeSession,
  AuthoritativeSnapshot,
  CommandId,
  EntityId,
  PlayerId,
  PlayerInventoryAction,
  WorldId,
} from '../src/index'

const world = WorldId.make('overworld')
const player = PlayerId.make('alice')

const snapshotFor = (targetWorld = world, revision = 4): AuthoritativeSnapshot => ({
  _tag: 'AuthoritativeSnapshot',
  containers: [],
  furnaces: [],
  inventories: [{ player, state: { slots: [{ item: 'stone', count: 2 }], selectedSlot: 0 } }],
  revision,
  timeWeather: { timeOfDay: 6000, weather: 'clear' },
  villagerTrades: [],
  vitals: [{ player, state: { health: 20, hunger: 20, experience: 0 } }],
  world: targetWorld,
})

const command = (
  id: string,
  expectedRevision = 4,
  commandPlayer = player,
  commandWorld = world,
): Extract<AuthoritativeCommand, { readonly _tag: 'PlayerInventoryCommand' }> => ({
  _tag: 'PlayerInventoryCommand',
  action: { _tag: 'select-slot', slot: 0 },
  commandId: CommandId.make(id),
  expectedRevision,
  player: commandPlayer,
  world: commandWorld,
})

const networkIntentFor = (id: string) => Schema.decodeUnknownSync(IntentSchema)({
  expectedDimensionRevision: 3,
  expectedRevision: 4,
  id: CommandId.make(id),
  payload: { _tag: 'UseItem', actor: player, item: 1 },
  source: 'network',
  targetTick: 12,
})

const sessionAt = (revision: number, targetWorld = world) => {
  let currentRevision: number | undefined = revision
  const subject = new AuthoritativeSession((requestedWorld) =>
    requestedWorld === targetWorld ? currentRevision : undefined,
  )
  subject.restore(snapshotFor(targetWorld, revision))
  const identity = subject.connect(player, targetWorld)
  return {
    subject,
    identity,
    get revision() {
      return currentRevision
    },
    set revision(value: number | undefined) {
      currentRevision = value
    },
  }
}

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
    expect(Result.isSuccess(Schema.decodeUnknownResult(AuthoritativeSnapshot)(snapshotFor()))).toBe(true)

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
      {
        ...command('furnace'),
        _tag: 'FurnaceCommand',
        action: { _tag: 'take-output', count: 1, destination: { _tag: 'player-slot', slot: 0 }, source: { _tag: 'furnace-slot', slot: 'output' } },
        furnaceId: 'furnace:1',
      },
      { ...command('trade'), _tag: 'VillagerTradeCommand', action: 'execute-trade', offerId: 'offer:1', villagerId: 'villager:1' },
    ]
    for (const value of commands) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(AuthoritativeCommand)(value))).toBe(true)
    }
  })

  it('decodes optional hostile lifecycle state without requiring it from older peers', () => {
    const entity: AuthoritativeEntityState = {
      _tag: 'living',
      at: { x: 0, y: 64, z: 0 },
      entityId: EntityId.make('zombie-1'),
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
    expect(Result.isSuccess(Schema.decodeUnknownResult(AuthoritativeEntityState)(entity))).toBe(true)
  })

  it('rejects missing, null, extra, unknown-tag, and out-of-range command metadata through the public schema', () => {
    const valid = command('valid')
    const invalidCommands: ReadonlyArray<unknown> = [
      { ...valid, commandId: undefined },
      { ...valid, commandId: null },
      { ...valid, expectedRevision: undefined },
      { ...valid, expectedRevision: null },
      { ...valid, player: undefined },
      { ...valid, world: null },
      { ...valid, extra: true },
      { ...valid, action: { _tag: 'select-slot', slot: 0, extra: true } },
      { ...valid, _tag: 'UnknownCommand' },
      { ...valid, commandId: '' },
      { ...valid, expectedRevision: -1 },
      { ...valid, expectedRevision: 0.5 },
    ]
    for (const value of invalidCommands) {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(AuthoritativeCommand, { onExcessProperty: 'error' })(value),
        ),
        `invalid command must fail strict decoding: ${JSON.stringify(value)}`,
      ).toBe(true)
    }

    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(AuthoritativeCommand, { onExcessProperty: 'error' })({ ...valid, expectedRevision: 0 }),
      ),
    ).toBe(true)
  })

  it('holds strict command schema invariants for generated metadata and excess properties', () => {
    const decode = Schema.decodeUnknownResult(AuthoritativeCommand, { onExcessProperty: 'error' })
    const valid = command('generated')

    fc.assert(fc.property(fc.nat({ max: 1_000_000 }), (expectedRevision) => {
      expect(Result.isSuccess(decode({ ...valid, expectedRevision }))).toBe(true)
    }))
    fc.assert(fc.property(fc.nat({ max: 1_000_000 }), (offset) => {
      expect(Result.isFailure(decode({ ...valid, expectedRevision: -offset - 1 }))).toBe(true)
    }))
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 1, max: 9 }), (whole, tenth) => {
      expect(Result.isFailure(decode({ ...valid, expectedRevision: whole + tenth / 10 }))).toBe(true)
    }))
    fc.assert(fc.property(fc.constantFrom('_tag', 'action', 'commandId', 'expectedRevision', 'player', 'world'), (field) => {
      const missing: Record<string, unknown> = { ...valid }
      Reflect.deleteProperty(missing, field)
      expect(Result.isFailure(decode(missing))).toBe(true)
      expect(Result.isFailure(decode({ ...valid, [field]: null }))).toBe(true)
    }))
    fc.assert(fc.property(fc.jsonValue(), (extra) => {
      expect(Result.isFailure(decode({ ...valid, extra }))).toBe(true)
      expect(Result.isFailure(decode({ ...valid, action: { ...valid.action, extra } }))).toBe(true)
    }))
    fc.assert(fc.property(fc.string(), (tag) => {
      expect(Result.isFailure(decode({ ...valid, _tag: `Unknown:${tag}` }))).toBe(true)
    }))
  })
})

describe('authoritative command session', () => {
  it('separates server connection identity from player and world claims', async () => {
    const ready = sessionAt(4)
    let applications = 0
    const apply = () => {
      applications += 1
      return Effect.succeed({ accepted: true } as const)
    }

    const missing = await Effect.runPromise(
      ready.subject.execute(Symbol('unissued'), command('missing'), apply),
    )
    const anotherPlayer = await Effect.runPromise(
      ready.subject.execute(
        ready.identity,
        command('wrong-player', 4, PlayerId.make('bob')),
        apply,
      ),
    )
    const anotherWorld = await Effect.runPromise(
      ready.subject.execute(
        ready.identity,
        command('wrong-world', 4, player, WorldId.make('nether')),
        apply,
      ),
    )

    expect(missing).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'unauthorized-player' })
    expect(anotherPlayer).toMatchObject({ reason: 'unauthorized-player' })
    expect(anotherWorld).toMatchObject({ reason: 'unauthorized-player' })
    expect(applications).toBe(0)
    expect(ready.subject.revision(world)).toBe(4)
  })

  it('requires a WCC revision and a restored snapshot after connection and disconnect', async () => {
    let currentRevision: number | undefined = 4
    const subject = new AuthoritativeSession(() => currentRevision)
    const identity = subject.connect(player, world)
    const beforeRestore = await Effect.runPromise(
      subject.execute(identity, command('before-restore'), () => Effect.succeed({ accepted: true })),
    )
    expect(beforeRestore).toMatchObject({ reason: 'snapshot-required', resyncRequired: true })

    subject.restore(snapshotFor())
    expect(subject.revision(world)).toBe(4)
    subject.disconnect(world)
    const revoked = await Effect.runPromise(
      subject.execute(identity, command('disconnected'), () => Effect.succeed({ accepted: true })),
    )
    expect(revoked).toMatchObject({ reason: 'unauthorized-player' })

    const reconnected = subject.connect(player, world)
    const beforeNewSnapshot = await Effect.runPromise(
      subject.execute(reconnected, command('reconnected'), () => Effect.succeed({ accepted: true })),
    )
    expect(beforeNewSnapshot).toMatchObject({ reason: 'snapshot-required', resyncRequired: true })
    currentRevision = 4
    subject.restore(snapshotFor())
    expect(subject.revision(world)).toBe(4)
  })

  it('leaves a world unready after a mismatched snapshot or invalid WCC revision', async () => {
    const currentRevision = 4
    const subject = new AuthoritativeSession(() => currentRevision)
    const identity = subject.connect(player, world)

    expect(subject.revision(world)).toBeUndefined()
    subject.restore(snapshotFor(world, 5))
    expect(subject.revision(world)).toBeUndefined()
    const mismatched = await Effect.runPromise(
      subject.execute(identity, command('mismatched-snapshot'), () => Effect.succeed({ accepted: true })),
    )
    expect(mismatched).toMatchObject({ reason: 'snapshot-required', resyncRequired: true })

    const invalidWccResults = await Promise.all([-2, Number.MAX_SAFE_INTEGER + 1].map(async (invalidRevision) => {
      const invalidWcc = new AuthoritativeSession(() => invalidRevision)
      const invalidIdentity = invalidWcc.connect(player, world)
      invalidWcc.restore(snapshotFor())
      const visibleRevision = invalidWcc.revision(world)
      const result = await Effect.runPromise(
        invalidWcc.execute(invalidIdentity, command(`invalid-wcc-${invalidRevision}`), () => Effect.succeed({ accepted: true })),
      )
      return { result, visibleRevision }
    }))
    for (const { result, visibleRevision } of invalidWccResults) {
      expect(visibleRevision).toBeUndefined()
      expect(result).toMatchObject({ reason: 'snapshot-required', resyncRequired: true })
    }
  })

  it('removes only targeted connections and clears every connection when no world is supplied', () => {
    const nether = WorldId.make('nether')
    const subject = new AuthoritativeSession((requestedWorld) => requestedWorld === world ? 4 : 7)
    subject.restore(snapshotFor())
    subject.restore(snapshotFor(nether, 7))
    const overworldIdentity = subject.connect(player, world)
    const netherIdentity = subject.connect(player, nether)

    subject.disconnect(world)
    expect(subject.preflight(overworldIdentity, command('disconnected', 4))).toMatchObject({ reason: 'unauthorized-player' })
    expect(subject.preflight(netherIdentity, command('kept', 7, player, nether))).toBeUndefined()

    subject.disconnect()
    expect(subject.preflight(netherIdentity, command('cleared', 7, player, nether))).toMatchObject({ reason: 'unauthorized-player' })
    expect(subject.revision(nether)).toBeUndefined()
  })

  it('rejects stale revisions without invoking simulation or changing the WCC revision', async () => {
    const ready = sessionAt(4)
    let invoked = false
    const result = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('stale', 3), () => {
        invoked = true
        return Effect.succeed({ accepted: true } as const)
      }),
    )

    expect(result).toMatchObject({ reason: 'stale-revision', resyncRequired: true, revision: 4 })
    expect(invoked).toBe(false)
    expect(ready.subject.revision(world)).toBe(4)
  })

  it('rejects generated invalid expected revisions before invoking simulation', async () => {
    const outcomes = await Promise.all([-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(async (expectedRevision) => {
      const ready = sessionAt(4)
      let invoked = false
      const result = await Effect.runPromise(
        ready.subject.execute(ready.identity, command(`invalid-revision-${expectedRevision}`, expectedRevision), () => {
          invoked = true
          return Effect.succeed({ accepted: true } as const)
        }),
      )
      return { invoked, result }
    }))

    for (const { invoked, result } of outcomes) {
      expect(result).toMatchObject({ reason: 'invalid-command', revision: 4 })
      expect(invoked).toBe(false)
    }
  })

  it('rejects an unsafe revision boundary before invoking simulation', async () => {
    const ready = sessionAt(Number.MAX_SAFE_INTEGER)
    let invoked = false
    const result = await Effect.runPromise(
      ready.subject.execute(
        ready.identity,
        command('max-safe', Number.MAX_SAFE_INTEGER),
        () => {
          invoked = true
          return Effect.succeed({ accepted: true } as const)
        },
      ),
    )

    expect(result).toMatchObject({ reason: 'invalid-command', revision: Number.MAX_SAFE_INTEGER })
    expect(invoked).toBe(false)
  })

  it('rejects network intents at a WCC revision that cannot advance safely', () => {
    const ready = sessionAt(Number.MAX_SAFE_INTEGER)
    const result = ready.subject.preflightIntent(
      ready.identity,
      command('intent-max-safe', Number.MAX_SAFE_INTEGER),
    )

    expect(result).toMatchObject({
      _tag: 'AuthoritativeCommandRejected',
      reason: 'invalid-command',
      revision: Number.MAX_SAFE_INTEGER,
    })
  })

  it('returns direct intent-execution preflight refusals without storing an intent', async () => {
    const ready = sessionAt(4)
    const result = await Effect.runPromise(
      ready.subject.executeIntent(Symbol('unissued'), command('unissued-intent'), networkIntentFor('unissued-intent')),
    )

    expect(result).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'unauthorized-player' })
  })

  it('rejects a command ID already accepted as an intent if it is replayed through the commit path', async () => {
    const ready = sessionAt(4)
    const request = command('intent-cannot-commit')
    const acceptedIntent = await Effect.runPromise(
      ready.subject.executeIntent(ready.identity, request, networkIntentFor('intent-cannot-commit')),
    )
    let invoked = false
    const committed = await Effect.runPromise(
      ready.subject.execute(ready.identity, request, () => {
        invoked = true
        return Effect.succeed({ accepted: true } as const)
      }),
    )

    expect(acceptedIntent).toMatchObject({ _tag: 'AuthoritativeCommandIntentAccepted' })
    expect(committed).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'invalid-command', revision: 4 })
    expect(invoked).toBe(false)
    expect(ready.subject.revision(world)).toBe(4)
  })

  it('uses the no-prior revision when intent conflicts arrive after the WCC revision disappears', async () => {
    const ready = sessionAt(4)
    const request = command('intent-revision-unavailable')
    const accepted = await Effect.runPromise(
      ready.subject.executeIntent(ready.identity, request, networkIntentFor('intent-revision-unavailable')),
    )
    ready.revision = undefined

    const changedIntent = await Effect.runPromise(
      ready.subject.executeIntent(
        ready.identity,
        { ...request, action: { _tag: 'select-slot', slot: 1 } },
        networkIntentFor('intent-revision-unavailable'),
      ),
    )
    let invoked = false
    const commit = await Effect.runPromise(
      ready.subject.execute(ready.identity, request, () => {
        invoked = true
        return Effect.succeed({ accepted: true } as const)
      }),
    )

    expect(accepted).toMatchObject({ _tag: 'AuthoritativeCommandIntentAccepted' })
    expect(changedIntent).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'invalid-command', revision: 0 })
    expect(commit).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'invalid-command', revision: 0 })
    expect(invoked).toBe(false)
  })

  it('rechecks WCC revision during intent preparation before reserving the command', async () => {
    const outcomes = await Promise.all([
      (async () => {
        let reads = 0
        const subject = new AuthoritativeSession(() => {
          reads += 1
          return reads <= 2 ? 4 : undefined
        })
        const identity = subject.connect(player, world)
        subject.restore(snapshotFor())
        const result = await Effect.runPromise(
          subject.executeIntent(identity, command('intent-revision-missing'), networkIntentFor('intent-revision-missing')),
        )
        return result
      })(),
      (async () => {
        let reads = 0
        const subject = new AuthoritativeSession(() => {
          reads += 1
          return reads <= 2 ? 4 : 5
        })
        const identity = subject.connect(player, world)
        subject.restore(snapshotFor())
        return Effect.runPromise(
          subject.executeIntent(identity, command('intent-revision-stale'), networkIntentFor('intent-revision-stale')),
        )
      })(),
    ])

    expect(outcomes[0]).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'snapshot-required' })
    expect(outcomes[1]).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'stale-revision', revision: 5 })
  })

  it('returns the accepted result for an identical payload and rejects command-id reuse with a different payload', async () => {
    const ready = sessionAt(4)
    let applications = 0
    const apply = () => Effect.sync(() => {
      applications += 1
      ready.revision = 5
      return { accepted: true } as const
    })
    const firstCommand = command('same-id')
    const first = await Effect.runPromise(ready.subject.execute(ready.identity, firstCommand, apply))
    const duplicate = await Effect.runPromise(ready.subject.execute(ready.identity, firstCommand, apply))
    ready.revision = undefined
    const conflicting = await Effect.runPromise(
      ready.subject.execute(ready.identity, { ...firstCommand, action: { _tag: 'select-slot', slot: 1 } }, apply),
    )

    expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 5 })
    expect(duplicate).toStrictEqual(first)
    expect(conflicting).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'invalid-command', revision: 0 })
    expect(applications).toBe(1)
    expect(ready.subject.revision(world)).toBeUndefined()
  })

  it('fails closed if WCC revision becomes unavailable between preflight and preparation', async () => {
    let revisionReads = 0
    const subject = new AuthoritativeSession(() => {
      revisionReads += 1
      return revisionReads <= 2 ? 4 : undefined
    })
    const identity = subject.connect(player, world)
    subject.restore(snapshotFor())
    let invoked = false

    const result = await Effect.runPromise(
      subject.execute(identity, command('revision-disappeared'), () => {
        invoked = true
        return Effect.succeed({ accepted: true } as const)
      }),
    )

    expect(result).toMatchObject({ reason: 'snapshot-required', resyncRequired: true })
    expect(invoked).toBe(false)
  })

  it('blocks overlapping commands for one world while an accepted command is still committing', async () => {
    const ready = sessionAt(4)
    let signalStarted: () => void = () => undefined
    let releaseCommit: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    let applications = 0
    const first = Effect.runPromise(
      ready.subject.execute(ready.identity, command('first-in-flight'), () =>
        Effect.promise(async () => {
          applications += 1
          signalStarted()
          await commitGate
          ready.revision = 5
          return { accepted: true } as const
        }),
      ),
    )

    await started
    ready.revision = undefined
    const sameRequest = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('first-in-flight'), () => {
        applications += 1
        return Effect.succeed({ accepted: true } as const)
      }),
    )
    const concurrent = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('second-in-flight'), () => {
        applications += 1
        return Effect.succeed({ accepted: true } as const)
      }),
    )
    releaseCommit()
    const accepted = await first

    expect(sameRequest).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'invalid-command', revision: 0 })
    expect(concurrent).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'invalid-command', revision: 0 })
    expect(accepted).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 5 })
    expect(applications).toBe(1)
    expect(ready.subject.revision(world)).toBe(5)
  })

  it('does not cache rejected decisions or advance the revision', async () => {
    const ready = sessionAt(4)
    const denied = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('retry-denied'), () =>
        Effect.succeed({ accepted: false, reason: 'insufficient-items' } as const),
      ),
    )
    expect(denied).toMatchObject({ reason: 'insufficient-items', resyncRequired: false })
    expect(ready.subject.revision(world)).toBe(4)

    const accepted = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('retry-denied'), () =>
        Effect.sync(() => {
          ready.revision = 5
          return { accepted: true } as const
        }),
      ),
    )
    expect(accepted).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 5 })
  })

  it('stores receipts for later accepted commands in the same player and world ledger', async () => {
    const ready = sessionAt(4)
    const apply = () => Effect.sync(() => {
      const nextRevision = (ready.revision ?? 0) + 1
      ready.revision = nextRevision
      return { accepted: true } as const
    })
    const first = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('first-ledger-entry', 4), apply),
    )
    const second = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('second-ledger-entry', 5), apply),
    )
    const replay = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('first-ledger-entry', 4), apply),
    )

    expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 5 })
    expect(second).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 6 })
    expect(replay).toStrictEqual(first)
  })

  it('rejects accepted simulation results unless WCC advances exactly once and permits retry', async () => {
    const ready = sessionAt(4)
    const request = command('uncommitted-success')
    const uncommitted = await Effect.runPromise(
      ready.subject.execute(ready.identity, request, () => Effect.succeed({ accepted: true } as const)),
    )
    expect(uncommitted).toMatchObject({ reason: 'invalid-command', revision: 4 })

    const retried = await Effect.runPromise(
      ready.subject.execute(ready.identity, request, () => Effect.sync(() => {
        ready.revision = 5
        return { accepted: true } as const
      })),
    )
    expect(retried).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 5 })

    const unavailableRevision = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('missing-after-success', 5), () => Effect.sync(() => {
        ready.revision = undefined
        return { accepted: true } as const
      })),
    )
    expect(unavailableRevision).toMatchObject({ reason: 'invalid-command', revision: 5 })
  })

  it('fingerprints nested arrays without depending on object key insertion order', async () => {
    const ready = sessionAt(4)
    const firstCommand = { ...command('array-fingerprint'), extra: [{ right: 2, left: 1 }] }
    const sameCommand = { ...command('array-fingerprint'), extra: [{ left: 1, right: 2 }] }
    let applications = 0
    const apply = () => Effect.sync(() => {
      applications += 1
      ready.revision = 5
      return { accepted: true } as const
    })

    const first = await Effect.runPromise(ready.subject.execute(ready.identity, firstCommand, apply))
    const replay = await Effect.runPromise(ready.subject.execute(ready.identity, sameCommand, apply))

    expect(replay).toStrictEqual(first)
    expect(applications).toBe(1)
  })

  it('preserves the exact typed simulation failure and records no accepted receipt before a successful retry', async () => {
    const ready = sessionAt(4)
    const failure = new Error('sim mutation failed')
    const failedExit = await Effect.runPromiseExit(
      ready.subject.execute(ready.identity, command('typed-failure'), () => Effect.fail(failure)),
    )

    expect(Exit.isFailure(failedExit)).toBe(true)
    if (Exit.isFailure(failedExit)) {
      expect(Cause.squash(failedExit.cause)).toBe(failure)
    }
    expect(ready.subject.revision(world)).toBe(4)

    let applications = 0
    const retry = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('typed-failure'), () =>
        Effect.sync(() => {
          applications += 1
          ready.revision = 5
          return { accepted: true } as const
        }),
      ),
    )
    const replay = await Effect.runPromise(
      ready.subject.execute(ready.identity, command('typed-failure'), () => {
        applications += 1
        return Effect.succeed({ accepted: true } as const)
      }),
    )

    expect(retry).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 5 })
    expect(replay).toStrictEqual(retry)
    expect(applications).toBe(1)
  })

  it('scopes accepted command IDs by player and world', async () => {
    const ready = sessionAt(4)
    const bob = PlayerId.make('bob')
    const bobIdentity = ready.subject.connect(bob, world)
    await Effect.runPromise(
      ready.subject.execute(ready.identity, command('shared-id'), () =>
        Effect.sync(() => {
          ready.revision = 5
          return { accepted: true } as const
        }),
      ),
    )
    const bobResult = await Effect.runPromise(
      ready.subject.execute(bobIdentity, command('shared-id', 5, bob), () =>
        Effect.sync(() => {
          ready.revision = 6
          return { accepted: true } as const
        }),
      ),
    )

    expect(bobResult).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 6 })
  })

  it('replays generated command IDs once across safe WCC revisions', async () => {
    await fc.assert(fc.asyncProperty(fc.nat({ max: 1_000_000 }), async (revision) => {
      const ready = sessionAt(revision)
      const request = command(`generated-${revision}`, revision)
      let applications = 0
      const apply = () => Effect.sync(() => {
        applications += 1
        ready.revision = revision + 1
        return { accepted: true } as const
      })

      const first = await Effect.runPromise(ready.subject.execute(ready.identity, request, apply))
      const replay = await Effect.runPromise(ready.subject.execute(ready.identity, request, apply))

      expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: revision + 1 })
      expect(replay).toStrictEqual(first)
      expect(applications).toBe(1)
    }))
  })
})
