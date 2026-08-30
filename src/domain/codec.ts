/**
 * Frame codec: `NetworkMessage` <-> wire text.
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * ---------------------------------------------------------------------------
 * Why the codec produces TEXT and not bytes
 * ---------------------------------------------------------------------------
 *
 * The reference implementation's codec
 * (`packages/network/application/codec.ts`, 34 LOC) hands back an
 * `ArrayBuffer`, which means it reaches for `TextEncoder`/`TextDecoder` — and
 * those are platform globals, not language ones. That made the codec
 * untestable without a DOM-ish environment and pinned the protocol layer to a
 * runtime.
 *
 * Here the domain codec stops at text. Turning text into whatever the socket
 * wants (UTF-8 bytes, a compressed frame, a length-prefixed record) is the
 * adapter's job, in whichever repository owns the platform. The benefit is
 * concrete: `tsconfig.build.json` compiles this repository with `lib: ["ES2024"]`
 * and `types: []` — no DOM, no Node — so a protocol change cannot quietly
 * acquire a platform dependency.
 *
 * ---------------------------------------------------------------------------
 * Round trip is the contract
 * ---------------------------------------------------------------------------
 *
 * `decodeFrame(encodeFrame(m)) === m` for every representable `m`. That is the
 * property `test/codec.test.ts` exercises message by message, and it is the
 * reason the payload schemas carry `finite()` / `int()` refinements: JSON turns
 * `NaN` and `Infinity` into `null`, so an unconstrained number would break the
 * round trip at the far end, where the frame is no longer available to debug.
 */
import { Either, Schema } from 'effect'
import { Frame, NetworkMessage, type NetworkMessage as NetworkMessageType, PROTOCOL_VERSION } from './protocol.js'
import { ProtocolError } from './errors.js'

/**
 * One frame, as text. Exactly one message; framing multiple messages into a
 * single socket write is a transport concern, not a protocol one.
 */
export type WireText = string

/** `Frame` viewed through JSON: decoding takes text, encoding produces text. */
const WireFrame = Schema.parseJson(Frame)

/** The stable envelope decoded before inspecting a version-specific message. */
const WireEnvelope = Schema.parseJson(
  // eslint-disable-next-line new-cap
  Schema.Struct({
    message: Schema.Unknown,
    protocolVersion: Schema.Number.pipe(Schema.int()),
  }),
)

const decodeWireEnvelope = Schema.decodeUnknownEither(WireEnvelope)
const decodeNetworkMessage = Schema.decodeUnknownEither(NetworkMessage)
const encodeWireFrame = Schema.encodeEither(WireFrame)

/**
 * Encode a message at an explicit protocol version.
 *
 * Exists so that tests can forge a frame from a version this build does not
 * speak — the only way to prove the version check actually rejects rather than
 * best-effort parses. Production code calls `encodeFrame`.
 */
export const encodeFrameAsVersion = (
  protocolVersion: number,
  message: NetworkMessageType,
): Either.Either<WireText, ProtocolError> =>
  Either.mapLeft(
    encodeWireFrame({ message, protocolVersion }),
    (error) =>
      new ProtocolError({
        detail: error.message,
        reason: 'unencodable-message',
      }),
  )

/** Encode a message into a frame at this build's protocol version. */
export const encodeFrame = (message: NetworkMessageType): Either.Either<WireText, ProtocolError> =>
  encodeFrameAsVersion(PROTOCOL_VERSION, message)

/**
 * Decode a frame.
 *
 * Two distinct failures, never merged:
 *
 * - `malformed-frame` — the text is not JSON, or is JSON that is not a frame,
 *   or carries a message tag this build does not know. Drop it.
 * - `unsupported-protocol-version` — it IS a frame, and it is from a peer this
 *   build cannot talk to. Drop the *peer*, and say so to the user.
 *
 * The stable envelope is decoded first, with its message left opaque. This lets
 * an older build reject a future protocol version without trying to understand
 * that version's message schema. Only a supported version reaches the
 * `NetworkMessage` decoder.
 */
export const decodeFrame = (text: WireText): Either.Either<NetworkMessageType, ProtocolError> =>
  Either.flatMap(
    Either.mapLeft(
      decodeWireEnvelope(text),
      (error) =>
        new ProtocolError({
          detail: error.message,
          reason: 'malformed-frame',
        }),
    ),
    (envelope) => {
      if (envelope.protocolVersion !== PROTOCOL_VERSION) {
        return Either.left(
          new ProtocolError({
            detail:
              `peer speaks protocol version ${String(envelope.protocolVersion)}, ` +
              `this build speaks ${String(PROTOCOL_VERSION)}`,
            reason: 'unsupported-protocol-version',
          }),
        )
      }

      return Either.mapLeft(
        decodeNetworkMessage(envelope.message),
        (error) =>
          new ProtocolError({
            detail: error.message,
            reason: 'malformed-frame',
          }),
      )
    },
  )
