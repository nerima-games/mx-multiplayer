import { describe, expect, it } from '@effect/vitest'
import { Result } from 'effect'
import { decodeFrame } from '../../src/domain/codec.js'
import { PROTOCOL_VERSION } from '../../src/domain/protocol.js'
import { runAuthoritySyncProbe } from '../../scenarios/authority.js'
import { createScenarioRuntime } from '../../scenarios/runtime.js'
import {
  CONTAINER_AUTHORITY_SCENARIO,
  CONTAINER_REDELIVERY_SCENARIO,
  CONTAINER_UNAUTHORIZED_SCENARIO,
} from '../../scenarios/containers.js'

const ZERO = 0
const ONE = 1
const TWO = 2
const THREE = 3
const FOUR = 4
const FIXED_SEED = 37

const shapeCases: ReadonlyArray<Readonly<{ readonly tag: string; readonly validMessage: unknown; readonly malformedMessage: unknown }>> = [
  {
    tag: 'ContainerDelta',
    validMessage: {
      _tag: 'ContainerDelta',
      revision: ZERO,
      state: { containerId: 'chest:1', kind: 'chest', slots: [] },
      world: 'overworld',
    },
    malformedMessage: {
      _tag: 'ContainerDelta',
      revision: ZERO,
      state: { containerId: 'chest:1', slots: [] },
      world: 'overworld',
    },
  },
  {
    tag: 'FurnaceDelta',
    validMessage: {
      _tag: 'FurnaceDelta',
      revision: ZERO,
      state: { burnTicksRemaining: ZERO, cookTicks: ZERO, fuel: null, furnaceId: 'furnace:1', input: null, output: null },
      world: 'overworld',
    },
    malformedMessage: {
      _tag: 'FurnaceDelta',
      revision: ZERO,
      state: { burnTicksRemaining: -ONE, cookTicks: ZERO, fuel: null, furnaceId: 'furnace:1', input: null, output: null },
      world: 'overworld',
    },
  },
  {
    tag: 'VillagerTradeDelta',
    validMessage: {
      _tag: 'VillagerTradeDelta',
      revision: ZERO,
      state: { offers: [{ input: [], maxUses: ONE, offerId: 'offer:1', output: { item: 'emerald', count: ONE }, uses: ZERO }], villagerId: 'villager:1' },
      world: 'overworld',
    },
    malformedMessage: {
      _tag: 'VillagerTradeDelta',
      revision: ZERO,
      state: { offers: [{ input: [], maxUses: ONE, offerId: '', output: { item: 'emerald', count: ONE }, uses: ZERO }], villagerId: 'villager:1' },
      world: 'overworld',
    },
  },
  {
    tag: 'ContainerCommand',
    validMessage: {
      _tag: 'ContainerCommand',
      action: { _tag: 'open' },
      commandId: 'g3-valid-container',
      containerId: 'chest:1',
      expectedRevision: ZERO,
      player: 'scenario-player-a',
      world: 'overworld',
    },
    malformedMessage: {
      _tag: 'ContainerCommand',
      action: { _tag: 'move-item', count: ONE, destination: { _tag: 'player-slot', slot: ONE }, source: { _tag: 'player-slot', slot: ZERO } },
      commandId: 'g3-malformed-container',
      containerId: 'chest:1',
      expectedRevision: ZERO,
      player: 'scenario-player-a',
      world: 'overworld',
    },
  },
  {
    tag: 'FurnaceCommand',
    validMessage: {
      _tag: 'FurnaceCommand',
      action: { _tag: 'take-output', count: ONE, destination: { _tag: 'player-slot', slot: ONE }, source: { _tag: 'furnace-slot', slot: 'output' } },
      commandId: 'g3-valid-furnace',
      expectedRevision: ZERO,
      furnaceId: 'furnace:1',
      player: 'scenario-player-a',
      world: 'overworld',
    },
    malformedMessage: {
      _tag: 'FurnaceCommand',
      action: { _tag: 'take-output', count: ONE, destination: { _tag: 'player-slot', slot: ONE }, source: { _tag: 'furnace-slot', slot: 'input' } },
      commandId: 'g3-malformed-furnace',
      expectedRevision: ZERO,
      furnaceId: 'furnace:1',
      player: 'scenario-player-a',
      world: 'overworld',
    },
  },
  {
    tag: 'VillagerTradeCommand',
    validMessage: {
      _tag: 'VillagerTradeCommand',
      action: 'execute-trade',
      commandId: 'g3-valid-trade',
      expectedRevision: ZERO,
      offerId: 'offer:1',
      player: 'scenario-player-a',
      villagerId: 'villager:1',
      world: 'overworld',
    },
    malformedMessage: {
      _tag: 'VillagerTradeCommand',
      action: 'execute-trade',
      commandId: 'g3-malformed-trade',
      expectedRevision: ZERO,
      offerId: '',
      player: 'scenario-player-a',
      villagerId: 'villager:1',
      world: 'overworld',
    },
  },
]

const malformedFrame = (message: unknown): string => JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })

describe('container group scenarios', () => {
  // Fails if any container wire tag accepts an invalid payload shape at the codec boundary.
  it('accepts valid controls and rejects malformed frames for every container tag', () => {
    expect(shapeCases.map(({ tag }) => tag)).toStrictEqual([
      'ContainerDelta',
      'FurnaceDelta',
      'VillagerTradeDelta',
      'ContainerCommand',
      'FurnaceCommand',
      'VillagerTradeCommand',
    ])

    for (const { tag, validMessage, malformedMessage } of shapeCases) {
      expect(Result.isSuccess(decodeFrame(malformedFrame(validMessage))), `${tag} valid control should decode`).toBe(true)
      expect(Result.isFailure(decodeFrame(malformedFrame(malformedMessage))), `${tag} should reject malformed input`).toBe(true)
    }
  })

  // Fails if an available command is rejected or either currently unsupported command stops returning its typed rejection.
  it('records the available container, furnace, and villager trade authority decisions', async () => {
    const runtime = await createScenarioRuntime(CONTAINER_AUTHORITY_SCENARIO, { seed: FIXED_SEED })
    const result = await runtime.run(ONE)

    expect(result.angle).toBe('A2')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog.map(({ tag, outcome, result: decision }) => [tag, outcome, decision])).toStrictEqual([
      ['ContainerCommand', 'rejected', 'authority marked command unsupported: no-matching-c2-intent-payload'],
      ['FurnaceCommand', 'rejected', 'authority marked command unsupported: no-matching-c2-intent-payload'],
      ['VillagerTradeCommand', 'accepted', 'authority accepted canonical intent; world state was not applied'],
    ])
    expect(result.authority).toMatchObject({ acceptedCommands: ONE, rejectedCommands: TWO })
    expect(result.clients.map(({ accepted, rejected }) => [accepted, rejected])).toStrictEqual([
      [ONE, TWO],
      [ZERO, ZERO],
    ])
  })

  // Fails if a command can claim another player's identity, while the valid trade control confirms the authority path remains usable.
  it('rejects player-spoofed container commands while preserving valid trade authority', async () => {
    const runtime = await createScenarioRuntime(CONTAINER_UNAUTHORIZED_SCENARIO, { seed: FIXED_SEED })
    const result = await runtime.run(ONE)

    expect(result.angle).toBe('A7')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog.map(({ tag, outcome, result: decision }) => [tag, outcome, decision])).toStrictEqual([
      ['VillagerTradeCommand', 'accepted', 'authority accepted canonical intent; world state was not applied'],
      ['ContainerCommand', 'rejected', 'authority rejected command: unauthorized-player'],
      ['FurnaceCommand', 'rejected', 'authority rejected command: unauthorized-player'],
      ['VillagerTradeCommand', 'rejected', 'authority rejected command: unauthorized-player'],
    ])
    expect(result.authority).toMatchObject({ acceptedCommands: ONE, rejectedCommands: THREE })
    expect(result.clients.map(({ accepted, rejected }) => [accepted, rejected])).toStrictEqual([
      [ZERO, THREE],
      [ONE, ZERO],
    ])
  })

  // Fails if delivery faults or a repeated trade command change the final authority decision or fail to request resync after a revision gap.
  it('preserves command outcomes across loss, duplication, reordering, delay, and resync', async () => {
    const faults = [
      { kind: 'none' },
      { atFrame: ONE, clientId: 'client-a', kind: 'drop' },
      { atFrame: ONE, clientId: 'client-a', frames: ONE, kind: 'delay' },
      { atFrame: ONE, kind: 'reorder' },
    ] as const

    const results = await Promise.all(faults.map(async (fault) => {
      const runtime = await createScenarioRuntime(CONTAINER_REDELIVERY_SCENARIO, { fault, seed: FIXED_SEED })
      return { fault, result: await runtime.run(TWO) }
    }))

    for (const { fault, result } of results) {
      const droppedCount = fault.kind === 'drop' ? THREE : ZERO
      const deliveredTrades = result.wireLog.filter((entry) => entry.tag === 'VillagerTradeCommand' && entry.outcome !== 'dropped')
      const unsupportedDecisions = result.wireLog.filter((entry) =>
        (entry.tag === 'ContainerCommand' || entry.tag === 'FurnaceCommand') && entry.outcome !== 'dropped')

      expect(result.verdict.status, fault.kind).toBe('pass')
      expect(result.wireLog.filter((entry) => entry.outcome === 'dropped')).toHaveLength(droppedCount)
      expect(unsupportedDecisions.length).toBeGreaterThan(ZERO)
      expect(unsupportedDecisions.every((entry) =>
        entry.outcome === 'rejected' && entry.result === 'authority marked command unsupported: no-matching-c2-intent-payload')).toBe(true)
      expect(deliveredTrades.map((entry) => entry.result)).toStrictEqual(fault.kind === 'drop'
        ? ['authority accepted canonical intent; world state was not applied']
        : [
            'authority accepted canonical intent; world state was not applied',
            'authority acknowledged accepted intent replay',
          ])
      expect(result.authority).toMatchObject({
        acceptedCommands: ONE,
        rejectedCommands: fault.kind === 'drop' ? TWO : FOUR,
      })
    }

    const probe = runAuthoritySyncProbe()
    expect(probe.gapTransition).toMatchObject({
      accepted: false,
      reason: 'revision-gap',
      request: { lastKnownRevision: FOUR },
    })
    expect(probe.gapAfter).toBe(probe.gapBefore)
  })
})
