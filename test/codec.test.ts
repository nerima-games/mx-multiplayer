import { describe, expect, it } from '@effect/vitest'
import { Effect, Either, Option } from 'effect'
import { decodeFrame, encodeFrame, encodeFrameAsVersion } from '../domain/codec'
import type { ProtocolError } from '../domain/errors'
import {
  MESSAGE_TAGS,
  PROTOCOL_VERSION,
  PlayerId,
  PlayerName,
  WorldId,
  type NetworkMessage,
} from '../domain/protocol'

const alice = PlayerId.make('alice')
const overworld = WorldId.make('overworld')

/**
 * One sample per message tag. `SAMPLES` is keyed by tag so that the
 * exhaustiveness test below can prove no message escapes the round-trip check.
 */
const SAMPLES: { readonly [Tag in NetworkMessage['_tag']]: Extract<NetworkMessage, { _tag: Tag }> } = {
  PlayerJoin: {
    _tag: 'PlayerJoin',
    player: alice,
    name: PlayerName.make('Alice'),
    at: { x: 8.5, y: 65, z: -12.25 },
  },
  PlayerLeave: { _tag: 'PlayerLeave', player: alice },
  PlayerMove: {
    _tag: 'PlayerMove',
    player: alice,
    at: { x: -0.5, y: 64.125, z: 1024 },
    facing: { yawRadians: 3.14159, pitchRadians: -1.5 },
  },
  BlockPlace: { _tag: 'BlockPlace', player: alice, at: { x: 1, y: 2, z: 3 }, block: 'stone' },
  BlockBreak: { _tag: 'BlockBreak', player: alice, at: { x: -1, y: 0, z: -3 } },
  Chat: { _tag: 'Chat', player: alice, text: 'hello 世界' },
  WorldInfo: { _tag: 'WorldInfo', world: overworld, seed: -1_234_567 },
  Ping: { _tag: 'Ping', nonce: 7 },
  Pong: { _tag: 'Pong', nonce: 7 },
}

const encoded = (message: NetworkMessage): string => Either.getOrThrow(encodeFrame(message))

/** The ProtocolError a decode produced, or undefined if it succeeded. */
const failure = (result: Either.Either<unknown, ProtocolError>): ProtocolError | undefined =>
  Option.getOrUndefined(Either.getLeft(result))

describe('frame round trip', () => {
  // REGRESSION: "every message survives encode -> text -> decode unchanged".
  // This is the whole contract of the repository. A protocol change that breaks
  // it is only observable at the far end of a socket, where the frame is gone.
  it.effect('every message decodes back to a value strictly equal to the one encoded', () =>
    Effect.sync(() => {
      for (const tag of MESSAGE_TAGS) {
        const original = SAMPLES[tag]
        const result = decodeFrame(encoded(original))
        expect(Either.isRight(result), `${tag} failed to decode`).toBe(true)
        expect(Either.getOrThrow(result)).toStrictEqual(original)
      }
    }),
  )

  // REGRESSION: "a new message type cannot be added without a round-trip test".
  // Without this, MESSAGE_TAGS and SAMPLES drift and the loop above silently
  // stops covering the new case.
  it.effect('has a sample for every declared tag, and declares every sampled tag', () =>
    Effect.sync(() => {
      expect([...MESSAGE_TAGS].sort()).toStrictEqual(Object.keys(SAMPLES).sort())
    }),
  )

  it.effect('produces text — the codec stops at a string, so no platform global is needed', () =>
    Effect.sync(() => {
      const frame = encoded(SAMPLES.Ping)
      expect(typeof frame).toBe('string')
      expect(JSON.parse(frame)).toStrictEqual({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'Ping', nonce: 7 },
      })
    }),
  )

  // REGRESSION: "fractional coordinates survive". The reference implementation
  // carries positions as finite doubles; a codec that rounded, or that went
  // through a fixed-point integer encoding, would show up as peer avatars
  // snapping to the block grid rather than as a test failure.
  it.effect('preserves fractional coordinates exactly rather than snapping them to the grid', () =>
    Effect.sync(() => {
      const moved = decodeFrame(encoded(SAMPLES.PlayerMove))
      expect(Either.getOrThrow(moved)).toStrictEqual(SAMPLES.PlayerMove)
    }),
  )

  it.effect('preserves non-ASCII chat text', () =>
    Effect.sync(() => {
      const chat = decodeFrame(encoded(SAMPLES.Chat))
      expect(Either.getOrThrow(chat)).toStrictEqual(SAMPLES.Chat)
    }),
  )
})

describe('protocol version', () => {
  // REGRESSION: "a rolling upgrade is distinguishable from corruption".
  // The reference implementation had no version field, so a peer on an older
  // build produced decode failures indistinguishable from a damaged frame.
  it.effect('rejects a frame from a version this build does not speak, and says so specifically', () =>
    Effect.sync(() => {
      const fromTheFuture = Either.getOrThrow(encodeFrameAsVersion(PROTOCOL_VERSION + 1, SAMPLES.Ping))
      const result = decodeFrame(fromTheFuture)

      expect(Either.isLeft(result)).toBe(true)
      const error = failure(result)
      expect(error?._tag).toBe('ProtocolError')
      expect(error?.reason).toBe('unsupported-protocol-version')
      expect(error?.detail).toContain(String(PROTOCOL_VERSION + 1))
    }),
  )

  it.effect('reports a version mismatch as a version problem, never as a malformed frame', () =>
    Effect.sync(() => {
      const older = Either.getOrThrow(encodeFrameAsVersion(0, SAMPLES.PlayerLeave))
      expect(failure(decodeFrame(older))?.reason).not.toBe('malformed-frame')
    }),
  )
})

describe('malformed input', () => {
  const rejected = (text: string) => failure(decodeFrame(text))

  it.effect('rejects text that is not JSON at all', () =>
    Effect.sync(() => {
      expect(rejected('not json')?.reason).toBe('malformed-frame')
      expect(rejected('')?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects JSON that is not a frame', () =>
    Effect.sync(() => {
      expect(rejected('{}')?.reason).toBe('malformed-frame')
      expect(rejected('[]')?.reason).toBe('malformed-frame')
      expect(rejected('null')?.reason).toBe('malformed-frame')
    }),
  )

  // REGRESSION: "an unknown tag is rejected, not coerced into a neighbouring
  // case". A union that fell back to a default would apply a peer's message as
  // the wrong action.
  it.effect('rejects a message tag this build does not know instead of guessing', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'DetonateEverything', player: 'alice' },
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  // REGRESSION: "JSON.stringify(NaN) === 'null'". This is why every coordinate
  // carries `finite()`: without the refinement a NaN produced by a division by
  // zero on the sender becomes a decode failure on the RECEIVER, where the
  // originating code is no longer visible.
  it.effect('rejects a coordinate that arrived as null, which is what a NaN turns into over JSON', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'PlayerMove', player: 'alice', at: { x: null, y: 1, z: 2 }, facing: { yawRadians: 0, pitchRadians: 0 } },
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects a non-integral block coordinate', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'BlockBreak', player: 'alice', at: { x: 0.5, y: 1, z: 2 } },
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  // REGRESSION: "pitch outside ±π/2 is not a rotation a player can be in".
  // Letting it through produces an upside-down peer avatar, which nobody files
  // as a protocol bug.
  it.effect('rejects a pitch outside the range a head can actually turn', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          _tag: 'PlayerMove',
          player: 'alice',
          at: { x: 0, y: 0, z: 0 },
          facing: { yawRadians: 0, pitchRadians: 3.2 },
        },
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects an empty player id, so an unidentified peer cannot be addressed', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'PlayerLeave', player: '' },
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  // A block name this build does not know must still DECODE: rejecting it here
  // would turn "your client is older than mine" into a parse error. Deciding
  // what to do with an unknown block is mc-sim's, not the protocol's.
  it.effect('accepts a block name this build does not know, because content skew is not frame corruption', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'BlockPlace', player: 'alice', at: { x: 0, y: 0, z: 0 }, block: 'unobtainium' },
      })
      expect(Either.isRight(decodeFrame(text))).toBe(true)
    }),
  )
})
