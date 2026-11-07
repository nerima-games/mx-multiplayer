import { describe, expect, it } from '@effect/vitest'
import { CommandId, PlayerId, ReplicatedWorldDeltaMessage, WorldId } from '../../src/domain/protocol.js'
import { makeReplicatedOwnerId, type ReplicatedOwnerRegistration } from '@nerima-games/mc-sim'
import {
  createReplicatedOwnerRegistry,
  decodeFrame,
  encodeFrame,
  ReplicatedOwnerRegistryLimitsSchema,
  type ReplicatedOwnerRegistry,
} from '../../src/domain/codec.js'
import { WorldRevisionSchema } from '@nerima-games/mc-kernel'
import { Result, Schema } from 'effect'
import { MATRIX_ANGLES, MATRIX_ANGLE_MEANINGS } from '../matrix/index.js'
import { createScenarioRuntime } from '../../apps/debug-ui/entrypoints/scenarios/scenario-runtime.js'
import { SCENARIO_ANGLE_MEANINGS, SCENARIO_ANGLES, type ScenarioDefinition } from '../../scenarios/types.js'

const WORLD = WorldId.make('overworld')
const OWNER_ID = makeReplicatedOwnerId('scenario-contract-owner')
const OWNER_STATE_SCHEMA = Schema.Struct({ count: Schema.Number.pipe(Schema.check(Schema.isInt())) })
const OWNER_REGISTRATION: ReplicatedOwnerRegistration<typeof OWNER_STATE_SCHEMA> = {
  ownerId: OWNER_ID,
  schema: OWNER_STATE_SCHEMA,
  initialState: { count: 0 },
}
const OWNER_REGISTRY_LIMITS = Schema.decodeUnknownSync(ReplicatedOwnerRegistryLimitsSchema)({
  maxCollectionItems: 5,
  maxDeltaBlockChanges: 0,
  maxDeltaFrameBytes: 100_000,
  maxDepth: 13,
  maxRegisteredOwners: 1,
  maxSnapshotBlockReads: 0,
  maxSnapshotFrameBytes: 100_000,
  ownerStates: [{ maxCollectionItems: 1, maxStateBytes: 64, maxStateDepth: 2, ownerId: OWNER_ID }],
})
const OWNER_REGISTRY = Result.getOrThrow(createReplicatedOwnerRegistry([OWNER_REGISTRATION], OWNER_REGISTRY_LIMITS))
const EMPTY_OWNER_REGISTRY = Result.getOrThrow(createReplicatedOwnerRegistry([], {
  ...OWNER_REGISTRY_LIMITS,
  maxRegisteredOwners: 0,
  ownerStates: [],
}))
const ONE = 1
const OWNER_REPLAY_FRAMES = 2

const ownerDeltaFor = (frame: number, seed: number) => Schema.decodeUnknownSync(ReplicatedWorldDeltaMessage)({
  _tag: 'ReplicatedWorldDelta',
  blockChanges: [],
  changes: [{ owner: OWNER_ID, state: { count: frame + seed } }],
  revision: Schema.decodeUnknownSync(WorldRevisionSchema)(frame),
  world: WORLD,
})

const ownerDeltaScenario = (owners: ReplicatedOwnerRegistry): ScenarioDefinition => ({
  id: 'h1.authority.owner-registry-delta',
  group: 'authority',
  angle: 'A1',
  title: 'Owner-registered C4 delta transport',
  description: 'Registered owner state is encoded, sent, decoded, and recorded through the scenario transport.',
  actions: ({ frame, seed }) => [{
    clientId: 'client-a',
    kind: 'message',
    message: ownerDeltaFor(frame, seed),
    owners,
  }],
  evaluate: ({ frame, clients, wireLog }) => {
    const ownerEntries = wireLog.filter((entry) => entry.tag === 'ReplicatedWorldDelta')
    const clientA = clients.find((client) => client.id === 'client-a')
    const passed = frame > 0
      && ownerEntries.length === frame
      && ownerEntries.every((entry) => entry.outcome === 'delivered')
      && clientA?.received === frame
    return {
      status: passed ? 'pass' : 'fail',
      summary: passed ? 'all owner deltas reached the authority decoder' : 'owner delta encode, transport, or decode failed',
    }
  },
})

const authorityScenario: ScenarioDefinition = {
  id: 'h1.authority.two-clients',
  group: 'authority',
  angle: 'A1',
  title: 'Two clients submit canonical intents',
  description: 'Both clients send a real command frame through transport, codec, and authority validation.',
  actions: ({ frame, seed, clients }) => clients.map((client) => ({
    clientId: client.id,
    kind: 'message',
    message: {
      _tag: 'BowUseCommand',
      action: 'start',
      commandId: CommandId.make(`h1-${String(seed)}-${String(frame)}-${client.id}`),
      expectedRevision: 0,
      player: PlayerId.make(client.player),
      world: WORLD,
    },
  })),
  evaluate: ({ frame, clients, authority }) => {
    const accepted = clients.every((client) => client.accepted === frame)
      && authority.acceptedCommands === frame * clients.length
    return {
      status: accepted ? 'pass' : 'incomplete',
      summary: accepted
        ? `${String(authority.acceptedCommands)} canonical intents accepted through the authority path`
        : 'waiting for both clients to submit an accepted intent for each logical frame',
    }
  },
}

describe('deterministic scenario contract', () => {
  // Fails if a scenario or matrix angle loses its user-facing title or meaning.
  it('defines non-empty meanings for every scenario and matrix angle', () => {
    for (const angle of SCENARIO_ANGLES) {
      expect(SCENARIO_ANGLE_MEANINGS[angle].title.trim()).not.toBe('')
      expect(SCENARIO_ANGLE_MEANINGS[angle].meaning.trim()).not.toBe('')
    }

    for (const angle of MATRIX_ANGLES) {
      expect(MATRIX_ANGLE_MEANINGS[angle].title.trim()).not.toBe('')
      expect(MATRIX_ANGLE_MEANINGS[angle].meaning.trim()).not.toBe('')
    }
  })

  it('keeps scenario and matrix A1-A7 angles aligned', () => {
    // If angle IDs drift, positional assignments can mislabel scenarios and create false matrix coverage.
    expect(MATRIX_ANGLES.slice(0, SCENARIO_ANGLES.length)).toStrictEqual(SCENARIO_ANGLES)
  })

  // Fails if an authority scenario produces different state or wire results when replayed with the same seed.
  it('replays identical wire logs, client states, authority state, and verdict for the same seed', async () => {
    const firstRuntime = await createScenarioRuntime(authorityScenario, { seed: 17 })
    const secondRuntime = await createScenarioRuntime(authorityScenario, { seed: 17 })
    const first = await firstRuntime.run(4)
    const second = await secondRuntime.run(4)

    expect(first.wireLog).toStrictEqual(second.wireLog)
    expect(first.clients).toStrictEqual(second.clients)
    expect(first.authority).toStrictEqual(second.authority)
    expect(first.verdict).toStrictEqual(second.verdict)
    expect(first.wireLog).toHaveLength(8)
    expect(first.wireLog.every((entry) => entry.tag === 'BowUseCommand' && entry.outcome === 'accepted')).toBe(true)
    expect(first.clients.map((client) => client.accepted)).toStrictEqual([4, 4])
    expect(first.authority.acceptedCommands).toBe(8)
    expect(first.verdict.status).toBe('pass')
  })

  // Fails if the owner-aware runtime skips encoding, the loopback transport, or owner-aware decoding.
  it('delivers a registered C4 delta through owner-aware encode, transport, and decode', async () => {
    const runtime = await createScenarioRuntime(ownerDeltaScenario(OWNER_REGISTRY), { seed: 43 })
    const result = await runtime.run(ONE)
    expect(result.wireLog).toHaveLength(ONE)
    const entry = result.wireLog[0]
    if (entry === undefined) {
      throw new Error('expected one delivered C4 delta')
    }
    expect(entry).toMatchObject({
      from: 'client-a',
      outcome: 'delivered',
      result: 'decoded ReplicatedWorldDelta',
      tag: 'ReplicatedWorldDelta',
    })
    expect(Result.getOrThrow(decodeFrame(entry.text, OWNER_REGISTRY))).toStrictEqual(ownerDeltaFor(ONE, 43))
    expect(result.clients.map((client) => [client.id, client.received])).toStrictEqual([
      ['client-a', ONE],
      ['client-b', 0],
    ])
    expect(result.verdict.status).toBe('pass')
  })

  // Fails if an unregistered owner is accepted by encode or reaches the transport as a delivered frame.
  it('rejects a C4 delta when the runtime action carries the wrong owner registry', async () => {
    const runtime = await createScenarioRuntime(ownerDeltaScenario(EMPTY_OWNER_REGISTRY), { seed: 43 })
    const result = await runtime.run(ONE)
    expect(result.wireLog).toHaveLength(ONE)
    const entry = result.wireLog[0]
    if (entry === undefined) {
      throw new Error('expected one rejected C4 delta')
    }
    expect(entry).toMatchObject({
      from: 'client-a',
      outcome: 'rejected',
      result: 'codec refused frame: unencodable-message',
      tag: 'ReplicatedWorldDelta',
    })
    expect(result.clients.map((client) => [client.id, client.submitted, client.received, client.rejected])).toStrictEqual([
      ['client-a', ONE, 0, ONE],
      ['client-b', 0, 0, 0],
    ])
    const validFrame = Result.getOrThrow(encodeFrame(ownerDeltaFor(ONE, 43), OWNER_REGISTRY))
    expect(Result.isFailure(decodeFrame(validFrame, EMPTY_OWNER_REGISTRY))).toBe(true)
    expect(result.verdict.status).toBe('fail')
  })

  // Fails if identical seeds produce different owner-aware wire frames or a seed is ignored by the replay.
  it('replays identical owner-registry wire logs for the same seed', async () => {
    const firstRuntime = await createScenarioRuntime(ownerDeltaScenario(OWNER_REGISTRY), { seed: 17 })
    const secondRuntime = await createScenarioRuntime(ownerDeltaScenario(OWNER_REGISTRY), { seed: 17 })
    const otherSeedRuntime = await createScenarioRuntime(ownerDeltaScenario(OWNER_REGISTRY), { seed: 18 })
    const first = await firstRuntime.run(OWNER_REPLAY_FRAMES)
    const second = await secondRuntime.run(OWNER_REPLAY_FRAMES)
    const otherSeed = await otherSeedRuntime.run(OWNER_REPLAY_FRAMES)

    expect(first.wireLog).toHaveLength(OWNER_REPLAY_FRAMES)
    expect(first.wireLog).toStrictEqual(second.wireLog)
    expect(first.wireLog).not.toStrictEqual(otherSeed.wireLog)
    expect(first.wireLog.every((entry) => entry.tag === 'ReplicatedWorldDelta' && entry.outcome === 'delivered')).toBe(true)
  })

  // Fails if stepping or runtime controls leave the frame, playback, or reset state inconsistent.
  it('advances one logical frame per step and exposes pause, play, speed, fault, and reset controls', async () => {
    const runtime = await createScenarioRuntime(authorityScenario, { seed: 29 })

    expect(runtime.snapshot().frame).toBe(0)
    expect((await runtime.step()).frame).toBe(1)
    expect((await runtime.step()).frame).toBe(2)
    expect((await runtime.run(3)).frame).toBe(5)
    expect(runtime.pause().playing).toBe(false)
    expect(runtime.play().playing).toBe(true)
    expect(runtime.setSpeed(2).speed).toBe(2)

    const beforeInvalidReset = runtime.snapshot()
    await expect(runtime.reset({ seed: -1 })).rejects.toThrow('scenario seed must be a non-negative safe integer')
    expect(runtime.snapshot()).toStrictEqual(beforeInvalidReset)

    const reset = await runtime.reset({
      seed: 31,
      fault: { kind: 'drop' },
      frame: 1,
      speed: 0.5,
      panel: 1,
    })
    expect(reset.seed).toBe(31)
    expect(reset.frame).toBe(1)
    expect(reset.speed).toBe(0.5)
    expect(reset.panel).toBe(1)
    expect(reset.playing).toBe(false)
    expect(reset.wireLog).toHaveLength(2)
    expect(reset.wireLog.every((entry) => entry.outcome === 'dropped')).toBe(true)
  })
})
