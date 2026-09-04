/* eslint-disable id-length, max-statements, no-magic-numbers, no-ternary, no-undefined, no-underscore-dangle, sort-imports, sort-keys -- Fixtures make authority transitions explicit. */
import { describe, expect, it } from '@effect/vitest'
import { PlayerId, SurvivalAuthority, WorldId, type SurvivalCommand, type SurvivalSnapshot } from '../src/index'

const alice = PlayerId.make('alice')
const bob = PlayerId.make('bob')
const initial = (): SurvivalSnapshot => ({
  world: WorldId.make('overworld'),
  revision: 7,
  actors: [
    { player: alice, session: 'alice-session', position: { x: 0, y: 64, z: 0 }, gameMode: 'survival', inventory: [{ item: 'stone', count: 2 }], health: 20, spawn: { x: 0, y: 64, z: 0 }, lastActionTick: 0 },
    { player: bob, session: 'bob-session', position: { x: 1, y: 64, z: 0 }, gameMode: 'survival', inventory: [{ item: 'apple', count: 1 }], health: 4, spawn: { x: 10, y: 70, z: 10 }, lastActionTick: 0 },
  ],
  blocks: { '2,64,0': 'dirt' },
  drops: [],
})

const header = (requestId: string, revision = 7) => ({ actor: alice, session: 'alice-session', requestId, expectedRevision: revision, clientTick: 10 })

describe('survival authority', () => {
  it('atomically consumes an inventory slot and places a block', () => {
    const authority = new SurvivalAuthority(initial())
    const result = authority.execute({ ...header('place'), _tag: 'PlaceBlock', at: { x: 1, y: 64, z: 1 }, slot: 0, block: 'stone' })
    expect(result).toMatchObject({ accepted: true, revision: 8, events: [{ _tag: 'InventoryChanged' }, { _tag: 'BlockChanged' }] })
    const snapshot = authority.snapshot()
    expect(snapshot).toMatchObject({ revision: 8, blocks: { '1,64,1': 'stone' } })
    expect(snapshot.actors[0]?.inventory[0]).toStrictEqual({ item: 'stone', count: 1 })
  })

  it('breaking a block with no configured drop clears the block and emits no ItemDropped event', () => {
    const authority = new SurvivalAuthority(initial(), { blockDrop: () => null })
    const result = authority.execute({ ...header('break-no-drop'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } })
    expect(result).toMatchObject({ accepted: true, revision: 8, events: [{ _tag: 'BlockChanged', block: null }] })
    expect(authority.snapshot().blocks['2,64,0']).toBeUndefined()
  })

  it('rejects spoofed, stale, duplicate, unreachable, cooldown and inventory-invalid commands without mutation', () => {
    const cases: ReadonlyArray<[SurvivalCommand, string]> = [
      [{ ...header('spoof'), actor: PlayerId.make('mallory'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } }, 'unauthorized-actor'],
      [{ ...header('session'), session: 'stolen', _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } }, 'session-mismatch'],
      [{ ...header('stale', 6), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } }, 'stale-revision'],
      [{ ...header('far'), _tag: 'BreakBlock', at: { x: 20, y: 64, z: 0 } }, 'out-of-reach'],
      [{ ...header('empty'), _tag: 'PlaceBlock', at: { x: 1, y: 64, z: 1 }, slot: 1, block: 'stone' }, 'insufficient-items'],
      [{ ...header('cooldown'), clientTick: 2, _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } }, 'cooldown-active'],
    ]
    for (const [command, reason] of cases) {
      const authority = new SurvivalAuthority(initial())
      expect(authority.execute(command)).toMatchObject({ accepted: false, reason, revision: 7 })
      expect(authority.snapshot()).toStrictEqual(initial())
    }
    const creativeSnapshot = initial()
    const creativeAuthority = new SurvivalAuthority({
      ...creativeSnapshot,
      actors: creativeSnapshot.actors.map((actor) => actor.player === alice ? { ...actor, gameMode: 'creative' } : actor),
    })
    expect(creativeAuthority.execute({ ...header('creative'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } })).toMatchObject({
      accepted: false,
      reason: 'invalid-game-mode',
      revision: 7,
    })
    const authority = new SurvivalAuthority(initial())
    const command = { ...header('same'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } } as const
    expect(authority.execute(command)).toMatchObject({ accepted: true, revision: 8 })
    expect(authority.execute(command)).toMatchObject({ accepted: false, reason: 'duplicate-request', revision: 8 })
  })

  it('emits deterministic damage, death, drops and respawn events', () => {
    const authority = new SurvivalAuthority(initial())
    expect(authority.execute({ ...header('kill'), _tag: 'Attack', target: bob })).toMatchObject({
      accepted: true,
      revision: 8,
      events: [{ _tag: 'ActorDamaged', health: 0 }, { _tag: 'ActorDied' }, { _tag: 'ItemDropped', item: 'apple' }],
    })
    expect(authority.execute({ actor: bob, session: 'bob-session', requestId: 'respawn', expectedRevision: 8, clientTick: 20, _tag: 'Respawn' })).toMatchObject({
      accepted: true,
      revision: 9,
      events: [{ _tag: 'ActorRespawned', at: { x: 10, y: 70, z: 10 }, health: 20 }],
    })
  })

  it('floors overkill damage at zero rather than going negative, so death detection (health === 0) still fires', () => {
    // bob starts at 4 health; an attackDamage far beyond that would drive health to -6
    // without a floor. Death detection below is a strict `health === 0` check, so an
    // unclamped negative health would silently skip ActorDied/ItemDropped entirely —
    // the target would end the command still nominally alive.
    const authority = new SurvivalAuthority(initial(), { attackDamage: 10 })
    const result = authority.execute({ ...header('overkill'), _tag: 'Attack', target: bob })
    expect(result).toMatchObject({
      accepted: true,
      events: [{ _tag: 'ActorDamaged', health: 0 }, { _tag: 'ActorDied' }, { _tag: 'ItemDropped', item: 'apple' }],
    })
    expect(authority.snapshot().actors.find((actor) => actor.player === bob)?.health).toBe(0)
  })

  it('round-trips snapshots and rotates the authenticated session on rejoin', () => {
    const first = new SurvivalAuthority(initial())
    first.execute({ ...header('break'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } })
    const restored = new SurvivalAuthority(first.snapshot())
    expect(restored.snapshot()).toStrictEqual(first.snapshot())
    expect(restored.rejoin(alice, 'alice-session', 'alice-rejoined')).toBe(true)
    expect(restored.execute({ actor: alice, session: 'alice-session', requestId: 'old', expectedRevision: 8, clientTick: 20, _tag: 'Respawn' })).toMatchObject({ reason: 'session-mismatch' })
  })

  it('authoritatively validates sleep and emits one threshold event', () => {
    const authority = new SurvivalAuthority(initial(), {
      sleepPercentage: 50,
      validateSleep: ({ bed }) => ({ dimension: 'overworld', bedValid: bed.y === 64, nightOrThunder: true, safe: true }),
    })
    const entered = authority.execute({ ...header('sleep'), _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } })
    expect(entered).toMatchObject({
      accepted: true,
      revision: 8,
      events: [
        { _tag: 'ActorSleepChanged', actor: alice },
        { _tag: 'SleepProgress', sleeping: 1, required: 1, connected: 2, ready: true },
        { _tag: 'NightSkipped', sleeping: 1, required: 1 },
      ],
    })
    expect(authority.snapshot().actors.every((actor) => actor.sleeping === undefined)).toBe(true)
    expect(authority.execute({ ...header('duplicate', 8), _tag: 'LeaveSleep' })).toMatchObject({ accepted: false, reason: 'not-sleeping' })
  })

  it('rejects spoofed, stale, duplicate and server-invalid sleep commands', () => {
    const command = { ...header('sleep'), _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } } as const
    const authority = new SurvivalAuthority(initial(), {
      validateSleep: () => ({ dimension: 'overworld', bedValid: true, nightOrThunder: false, safe: true }),
    })
    expect(authority.execute(command)).toMatchObject({ accepted: false, reason: 'not-sleep-time' })
    expect(authority.execute(command)).toMatchObject({ accepted: false, reason: 'duplicate-request' })
    expect(new SurvivalAuthority(initial()).execute({ ...command, requestId: 'spoof', actor: PlayerId.make('mallory') })).toMatchObject({ reason: 'unauthorized-actor' })
    expect(new SurvivalAuthority(initial()).execute({ ...command, requestId: 'stale', expectedRevision: 6 })).toMatchObject({ reason: 'stale-revision' })
    expect(new SurvivalAuthority(initial(), {
      validateSleep: () => ({ dimension: 'overworld', bedValid: true, nightOrThunder: true, safe: false }),
    }).execute(command)).toMatchObject({ reason: 'sleep-unsafe' })
    expect(new SurvivalAuthority(initial(), {
      validateSleep: () => ({ dimension: 'overworld', bedValid: false, nightOrThunder: true, safe: true }),
    }).execute(command)).toMatchObject({ reason: 'invalid-bed' })

    const leaveAuthority = new SurvivalAuthority(initial(), {
      validateSleep: () => ({ dimension: 'overworld', bedValid: true, nightOrThunder: true, safe: true }),
    })
    expect(leaveAuthority.execute({ ...command, requestId: 'enter-before-leave' })).toMatchObject({ accepted: true, revision: 8 })
    expect(leaveAuthority.execute({ ...header('leave', 8), _tag: 'LeaveSleep' })).toMatchObject({
      accepted: true,
      revision: 9,
      events: [{ _tag: 'ActorSleepChanged', sleeping: null }, { _tag: 'SleepProgress', sleeping: 0, ready: false }],
    })
  })

  it('persists sleep in snapshots and reconciles disconnect, death, dimension and bed invalidation', () => {
    let aliceValid = true
    const bobValid = true
    const authority = new SurvivalAuthority(initial(), {
      validateSleep: ({ actor }) => ({
        dimension: actor.player === alice && !aliceValid ? 'nether' : 'overworld',
        bedValid: actor.player === alice ? aliceValid : bobValid,
        nightOrThunder: true,
        safe: true,
      }),
    })
    expect(authority.execute({ ...header('alice-sleep'), _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } })).toMatchObject({ accepted: true })
    const restored = new SurvivalAuthority(authority.snapshot(), {
      validateSleep: ({ actor }) => ({ dimension: 'overworld', bedValid: actor.player === bob ? bobValid : aliceValid, nightOrThunder: true, safe: true }),
    })
    expect(restored.snapshot().actors[0]?.sleeping).toMatchObject({ dimension: 'overworld', bed: { x: 0, y: 64, z: 1 } })
    expect(restored.rejoin(alice, 'alice-session', 'alice-rejoined')).toBe(true)
    aliceValid = false
    expect(restored.reconcileSleep()).toMatchObject([{ _tag: 'ActorSleepChanged', actor: alice }, { _tag: 'SleepProgress', sleeping: 0 }])

    const deathBase = initial()
    const deathSnapshot: SurvivalSnapshot = { ...deathBase, actors: deathBase.actors.map((actor) => actor.player === bob ? { ...actor, sleeping: { dimension: 'overworld', bed: { x: 1, y: 64, z: 1 } } } : actor) }
    const deathAuthority = new SurvivalAuthority(deathSnapshot)
    const death = deathAuthority.execute({ ...header('kill-sleeper'), _tag: 'Attack', target: bob })
    expect(death).toMatchObject({ accepted: true })
    expect(death.accepted && death.events.some((event) => event._tag === 'ActorSleepChanged' && event.actor === bob)).toBe(true)
    expect(death.accepted && death.events.some((event) => event._tag === 'SleepProgress' && event.sleeping === 0)).toBe(true)

    const disconnectBase = initial()
    const disconnectSnapshot: SurvivalSnapshot = { ...disconnectBase, actors: disconnectBase.actors.map((actor) => actor.player === alice ? { ...actor, sleeping: { dimension: 'overworld', bed: { x: 0, y: 64, z: 1 } } } : actor) }
    const disconnectAuthority = new SurvivalAuthority(disconnectSnapshot)
    expect(disconnectAuthority.disconnect(bob)).toMatchObject([{ _tag: 'SleepProgress', connected: 1, required: 1 }, { _tag: 'NightSkipped' }])
    expect(disconnectAuthority.disconnect(bob)).toStrictEqual([])
  })

  it('copies a null inventory slot without touching it, in both the snapshot and a break command', () => {
    const base = initial()
    const withNullSlot: SurvivalSnapshot = {
      ...base,
      actors: base.actors.map((actor) => (actor.player === alice ? { ...actor, inventory: [null, ...actor.inventory] } : actor)),
    }
    const authority = new SurvivalAuthority(withNullSlot)
    expect(authority.snapshot().actors[0]?.inventory[0]).toBeNull()
    expect(authority.execute({ ...header('null-slot-place'), _tag: 'PlaceBlock', at: { x: 1, y: 64, z: 1 }, slot: 0, block: 'stone' })).toMatchObject({ reason: 'insufficient-items' })
    expect(authority.execute({ ...header('break-with-null'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } })).toMatchObject({ accepted: true })
  })

  it('falls back to a full sleep ratio for a non-finite sleepPercentage, and the default validator always rejects the bed', () => {
    const authority = new SurvivalAuthority(initial(), { sleepPercentage: Number.POSITIVE_INFINITY })
    expect(authority.execute({ ...header('default-sleep'), _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } })).toMatchObject({ accepted: false, reason: 'invalid-bed' })
  })

  it('rejects rejoin with a blank session, an unknown actor, or a mismatched previous session', () => {
    const authority = new SurvivalAuthority(initial())
    expect(authority.rejoin(alice, 'alice-session', '')).toBe(false)
    expect(authority.rejoin(PlayerId.make('mallory'), 'x', 'y')).toBe(false)
    expect(authority.rejoin(alice, 'wrong-previous', 'new-session')).toBe(false)
  })

  it('reports the departing actor stopped sleeping when they disconnect while asleep, down to zero required sleepers', () => {
    const base = initial()
    const soloSleeping: SurvivalSnapshot = {
      ...base,
      actors: [
        { ...base.actors[0]!, sleeping: { dimension: 'overworld', bed: { x: 0, y: 64, z: 1 } } },
        { ...base.actors[1]!, gameMode: 'creative' },
      ],
    }
    const authority = new SurvivalAuthority(soloSleeping)
    expect(authority.disconnect(alice)).toMatchObject([
      { _tag: 'ActorSleepChanged', actor: alice, sleeping: null },
      { _tag: 'SleepProgress', sleeping: 0, required: 0, connected: 0, ready: false },
    ])
  })

  it('leaves a still-valid sleeper asleep and reports no change', () => {
    const base = initial()
    const sleeping: SurvivalSnapshot = {
      ...base,
      actors: [{ ...base.actors[0]!, sleeping: { dimension: 'overworld', bed: { x: 0, y: 64, z: 1 } } }, base.actors[1]!],
    }
    const authority = new SurvivalAuthority(sleeping, {
      validateSleep: () => ({ dimension: 'overworld', bedValid: true, nightOrThunder: true, safe: true }),
    })
    expect(authority.reconcileSleep()).toStrictEqual([])
    expect(authority.snapshot().actors[0]?.sleeping).toMatchObject({ dimension: 'overworld' })
  })

  it('rejects a command with a blank requestId or session', () => {
    const authority = new SurvivalAuthority(initial())
    expect(authority.execute({ ...header(''), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } })).toMatchObject({ reason: 'invalid-command' })
    expect(authority.execute({ ...header('x'), session: '', _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } })).toMatchObject({ reason: 'invalid-command' })
  })

  it('rejects any non-Respawn, non-LeaveSleep command from a dead actor', () => {
    const base = initial()
    const dead: SurvivalSnapshot = { ...base, actors: base.actors.map((actor) => (actor.player === alice ? { ...actor, health: 0 } : actor)) }
    const authority = new SurvivalAuthority(dead)
    expect(authority.execute({ ...header('dead-break'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } })).toMatchObject({ reason: 'actor-dead' })
  })

  it('rejects a non-integer position, placing onto an occupied block, and breaking where nothing exists', () => {
    const authority = new SurvivalAuthority(initial())
    expect(authority.execute({ ...header('bad-pos'), _tag: 'BreakBlock', at: { x: 1.5, y: 64, z: 0 } })).toMatchObject({ reason: 'invalid-command' })
    expect(authority.execute({ ...header('occupied'), _tag: 'PlaceBlock', at: { x: 2, y: 64, z: 0 }, slot: 0, block: 'stone' })).toMatchObject({ reason: 'occupied' })
    expect(authority.execute({ ...header('missing'), _tag: 'BreakBlock', at: { x: 1, y: 64, z: 0 } })).toMatchObject({ reason: 'missing-block' })
  })

  it('clears the inventory slot entirely when the last item of a stack is placed', () => {
    const base = initial()
    const singleStack: SurvivalSnapshot = {
      ...base,
      actors: base.actors.map((actor) => (actor.player === alice ? { ...actor, inventory: [{ item: 'stone', count: 1 }] } : actor)),
    }
    const authority = new SurvivalAuthority(singleStack)
    const result = authority.execute({ ...header('last-stone'), _tag: 'PlaceBlock', at: { x: 1, y: 64, z: 1 }, slot: 0, block: 'stone' })
    expect(result).toMatchObject({ accepted: true, events: [{ _tag: 'InventoryChanged', slot: 0, stack: null }, { _tag: 'BlockChanged' }] })
    expect(authority.snapshot().actors[0]?.inventory[0]).toBeNull()
  })

  it('rejects attacking an unknown target, an already-dead target, or one out of reach', () => {
    const authority = new SurvivalAuthority(initial())
    expect(authority.execute({ ...header('ghost'), _tag: 'Attack', target: PlayerId.make('mallory') })).toMatchObject({ reason: 'target-not-found' })

    const base = initial()
    const deadTarget: SurvivalSnapshot = { ...base, actors: base.actors.map((actor) => (actor.player === bob ? { ...actor, health: 0 } : actor)) }
    expect(new SurvivalAuthority(deadTarget).execute({ ...header('already-dead'), _tag: 'Attack', target: bob })).toMatchObject({ reason: 'target-dead' })

    const farTarget: SurvivalSnapshot = { ...base, actors: base.actors.map((actor) => (actor.player === bob ? { ...actor, position: { x: 100, y: 64, z: 0 } } : actor)) }
    expect(new SurvivalAuthority(farTarget).execute({ ...header('far-target'), _tag: 'Attack', target: bob })).toMatchObject({ reason: 'out-of-reach' })
  })

  it('leaves a surviving target inventory untouched and does not disturb their sleep state, and a bystander stays unmodified', () => {
    const charlie = PlayerId.make('charlie')
    const base = initial()
    const durable: SurvivalSnapshot = {
      ...base,
      actors: [
        ...base.actors.map((actor) => (actor.player === bob ? { ...actor, health: 20, sleeping: { dimension: 'overworld', bed: { x: 1, y: 64, z: 1 } } } : actor)),
        { player: charlie, session: 'charlie-session', position: { x: 5, y: 64, z: 5 }, gameMode: 'survival' as const, inventory: [], health: 20, spawn: { x: 5, y: 64, z: 5 }, lastActionTick: 0 },
      ],
    }
    const authority = new SurvivalAuthority(durable)
    const result = authority.execute({ ...header('graze'), _tag: 'Attack', target: bob })
    expect(result).toMatchObject({ accepted: true, events: [{ _tag: 'ActorDamaged', health: 16 }] })
    expect(authority.snapshot().actors[1]).toMatchObject({ inventory: durable.actors[1]!.inventory, sleeping: { dimension: 'overworld' } })
    expect(authority.snapshot().actors[2]).toStrictEqual(durable.actors[2])
  })

  it('skips empty inventory slots when a killed target drops their items', () => {
    const base = initial()
    const withNullSlot: SurvivalSnapshot = {
      ...base,
      actors: base.actors.map((actor) => (actor.player === bob ? { ...actor, inventory: [null, { item: 'apple', count: 1 }] } : actor)),
    }
    const authority = new SurvivalAuthority(withNullSlot)
    const result = authority.execute({ ...header('kill-with-empty-slot'), _tag: 'Attack', target: bob })
    expect(result).toMatchObject({ accepted: true, events: [{ _tag: 'ActorDamaged', health: 0 }, { _tag: 'ActorDied' }, { _tag: 'ItemDropped', item: 'apple' }] })
    expect(result.accepted && result.events.filter((event) => event._tag === 'ItemDropped')).toHaveLength(1)
  })

  it('rejects entering sleep at a non-integer bed, too far from the bed, or while already asleep', () => {
    const authority = new SurvivalAuthority(initial(), {
      validateSleep: () => ({ dimension: 'overworld', bedValid: true, nightOrThunder: true, safe: true }),
    })
    expect(authority.execute({ ...header('bad-bed'), _tag: 'EnterSleep', bed: { x: 0.5, y: 64, z: 1 } })).toMatchObject({ reason: 'invalid-command' })
    expect(authority.execute({ ...header('far-bed'), _tag: 'EnterSleep', bed: { x: 50, y: 64, z: 1 } })).toMatchObject({ reason: 'out-of-reach' })

    const enter = authority.execute({ ...header('enter'), _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } })
    expect(enter).toMatchObject({ accepted: true })
    // clientTick advances past the cooldown so this reaches the
    // Already-sleeping check rather than being rejected as cooldown-active.
    expect(
      authority.execute({ ...header('already', enter.revision), clientTick: 20, _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } }),
    ).toMatchObject({ reason: 'already-sleeping' })
  })

  it('rejects Respawn from an actor who is still alive', () => {
    const authority = new SurvivalAuthority(initial())
    expect(authority.execute({ ...header('alive-respawn'), _tag: 'Respawn' })).toMatchObject({ reason: 'target-alive' })
  })
})
