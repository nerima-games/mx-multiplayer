import { describe, expect, it } from '@effect/vitest'
import { Result } from 'effect'
import { decodeFrame, encodeFrame } from '../../src/domain/codec.js'
import { AuthoritativeSession } from '../../src/index.js'
import { CommandId, PlayerId, PROTOCOL_VERSION, WorldId, type NetworkMessage } from '../../src/domain/protocol.js'
import { createScenarioRuntime } from '../../scenarios/runtime.js'
import {
  PLAYER_STATE_AUTHORITY_SCENARIO_FRAME_COUNT,
  PLAYER_STATE_UNAUTHORIZED_SCENARIO_FRAME_COUNT,
  playerStateAuthorityScenario,
  playerStateUnauthorizedScenario,
} from '../../scenarios/player-state.js'

const ZERO = 0
const SEED = 29
const WORLD = WorldId.make('overworld')
const PLAYER = PlayerId.make('g2-player')

const playerStateShapeCases: ReadonlyArray<{ readonly id: string; readonly valid: NetworkMessage; readonly malformed: unknown }> = [
  {
    id: 'PlayerVitalsDelta',
    valid: {
      _tag: 'PlayerVitalsDelta',
      player: PLAYER,
      revision: ZERO,
      state: { experience: ZERO, health: 20, hunger: 20 },
      world: WORLD,
    },
    malformed: {
      _tag: 'PlayerVitalsDelta',
      player: PLAYER,
      revision: ZERO,
      state: { experience: ZERO, health: -1, hunger: 20 },
      world: WORLD,
    },
  },
  {
    id: 'PlayerVitalsCommand',
    valid: {
      _tag: 'PlayerVitalsCommand',
      action: { _tag: 'activity', activity: 'walk', amount: 1 },
      commandId: CommandId.make('g2-vitals-shape'),
      expectedRevision: ZERO,
      player: PLAYER,
      world: WORLD,
    },
    malformed: {
      _tag: 'PlayerVitalsCommand',
      action: { _tag: 'activity', activity: 'walk', amount: ZERO },
      commandId: CommandId.make('g2-vitals-shape-invalid'),
      expectedRevision: ZERO,
      player: PLAYER,
      world: WORLD,
    },
  },
  {
    id: 'PlayerDamageCommandAccepted',
    valid: { _tag: 'PlayerDamageCommandAccepted', commandId: CommandId.make('g2-damage-accepted'), revision: ZERO },
    malformed: { _tag: 'PlayerDamageCommandAccepted', commandId: CommandId.make('g2-damage-accepted-invalid'), revision: -1 },
  },
  {
    id: 'PlayerDamageCommandRejected',
    valid: {
      _tag: 'PlayerDamageCommandRejected',
      commandId: CommandId.make('g2-damage-rejected'),
      reason: 'invalid-command',
      revision: ZERO,
    },
    malformed: {
      _tag: 'PlayerDamageCommandRejected',
      commandId: CommandId.make('g2-damage-rejected-invalid'),
      reason: 'unknown-reason',
      revision: ZERO,
    },
  },
]

const frameFor = (message: unknown): string => {
  const frame = JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
  if (frame === undefined) {
    throw new Error('player-state test message must be serializable')
  }
  return frame
}

describe('player state scenarios', () => {
  // This fails if a player-state wire refinement is removed or rejects a valid state/result message.
  it('rejects malformed vitals and damage-result frames while decoding valid controls', () => {
    for (const { id, valid, malformed } of playerStateShapeCases) {
      const decodedControl = decodeFrame(Result.getOrThrow(encodeFrame(valid)))
      expect(Result.getOrThrow(decodedControl), `${id} valid control`).toStrictEqual(valid)

      const decodedMalformed = decodeFrame(frameFor(malformed))
      expect(Result.isFailure(decodedMalformed), `${id} malformed input`).toBe(true)
      if (Result.isFailure(decodedMalformed)) {
        expect(decodedMalformed.failure.reason, `${id} rejection reason`).toBe('malformed-frame')
      }
    }
  })

  // This fails if inventory or vitals commands stop producing the authority result their C2 mapping permits.
  it('observes inventory and vitals application or unsupported outcomes under A2', async () => {
    const runtime = await createScenarioRuntime(playerStateAuthorityScenario, { seed: SEED })
    const result = await runtime.run(PLAYER_STATE_AUTHORITY_SCENARIO_FRAME_COUNT)

    expect(result.verdict).toMatchObject({ status: 'pass' })
    expect(result.angle).toBe('A2')
    expect(result.wireLog.map((entry) => ({ frame: entry.frame, outcome: entry.outcome, result: entry.result, tag: entry.tag })))
      .toStrictEqual([
        { frame: 1, outcome: 'rejected', result: 'authority marked command unsupported: no-matching-c2-intent-payload', tag: 'PlayerInventoryCommand' },
        { frame: 2, outcome: 'accepted', result: 'authority accepted canonical intent; world state was not applied', tag: 'PlayerVitalsCommand' },
        { frame: 3, outcome: 'rejected', result: 'authority marked command unsupported: no-matching-c2-intent-payload', tag: 'PlayerVitalsCommand' },
        { frame: 4, outcome: 'rejected', result: 'authority marked command unsupported: intent-payload-does-not-preserve-command', tag: 'PlayerVitalsCommand' },
      ])
  })

  // This fails if identity validation is moved after the unsupported inventory-action check.
  it('rejects a forged player ID before the authorized unsupported-action control under A7', async () => {
    const runtime = await createScenarioRuntime(playerStateUnauthorizedScenario, { seed: SEED })
    const result = await runtime.run(PLAYER_STATE_UNAUTHORIZED_SCENARIO_FRAME_COUNT)

    expect(result.verdict).toMatchObject({ status: 'pass' })
    expect(result.angle).toBe('A7')
    expect(result.wireLog.map((entry) => ({ frame: entry.frame, outcome: entry.outcome, result: entry.result })))
      .toStrictEqual([
        { frame: 1, outcome: 'rejected', result: 'authority rejected command: unauthorized-player' },
        { frame: 2, outcome: 'rejected', result: 'authority marked command unsupported: no-matching-c2-intent-payload' },
      ])
  })

  // This fails if a disconnected identity survives reconnect or a vitals command bypasses the restored snapshot gate.
  it('requires a restored player-vitals snapshot after reconnecting', () => {
    const subject = new AuthoritativeSession(() => ZERO)
    const vitalsCommand = {
      _tag: 'PlayerVitalsCommand' as const,
      action: { _tag: 'eat' as const, item: 'apple' },
      commandId: CommandId.make('g2-vitals-reconnect'),
      expectedRevision: ZERO,
      player: PLAYER,
      world: WORLD,
    }
    const firstIdentity = subject.connect(PLAYER, WORLD)
    const snapshot = {
      _tag: 'AuthoritativeSnapshot' as const,
      containers: [],
      furnaces: [],
      inventories: [{ player: PLAYER, state: { slots: [], selectedSlot: ZERO } }],
      revision: ZERO,
      timeWeather: { timeOfDay: ZERO, weather: 'clear' as const },
      villagerTrades: [],
      vitals: [{ player: PLAYER, state: { health: 20, hunger: 20, experience: ZERO } }],
      world: WORLD,
    }

    subject.restore(snapshot)
    expect(subject.preflight(firstIdentity, vitalsCommand)).toBeUndefined()
    subject.disconnect(WORLD)
    expect(subject.preflight(firstIdentity, vitalsCommand)).toMatchObject({ reason: 'unauthorized-player' })

    const reconnectedIdentity = subject.connect(PLAYER, WORLD)
    expect(subject.preflight(reconnectedIdentity, vitalsCommand)).toMatchObject({ reason: 'snapshot-required' })
    subject.restore(snapshot)
    expect(subject.preflight(reconnectedIdentity, vitalsCommand)).toBeUndefined()
  })
})
