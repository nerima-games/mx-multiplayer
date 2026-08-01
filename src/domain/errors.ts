/**
 * The two failure modes this repository can produce.
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * They are kept separate because they are handled at different layers, and
 * conflating them was a real source of confusion in the reference
 * implementation (`packages/network/domain/errors.ts` has a single
 * `NetworkError` covering both):
 *
 * - `ProtocolError` means the bytes were delivered fine but do not mean what
 *   this build thinks they mean. Retrying is pointless; the peer is wrong, or
 *   is speaking a different protocol version. The correct response is to drop
 *   the frame (or the peer), never to resend.
 * - `TransportError` means the bytes did not get through. Retrying is exactly
 *   the right response, and the message itself is still valid.
 *
 * A single error type forces every call site to re-derive that distinction from
 * a string, which is how "reconnect on a malformed packet" loops get written.
 */
import { Data } from 'effect'

export type ProtocolErrorReason =
  /** The frame text is not valid JSON, or does not match any known message. */
  | 'malformed-frame'
  /** The frame parsed, but its `protocolVersion` is one this build cannot speak. */
  | 'unsupported-protocol-version'
  /** A message value could not be turned into a frame (a branded invariant was violated). */
  | 'unencodable-message'

export class ProtocolError extends Data.TaggedError('ProtocolError')<{
  readonly reason: ProtocolErrorReason
  readonly detail: string
}> {}

export type TransportErrorReason =
  /** A send was attempted while the connection was not in `Connected`. */
  | 'not-connected'
  /** The underlying socket rejected the write. */
  | 'send-failed'
  /** The peer or the local side closed the connection. */
  | 'closed'

export class TransportError extends Data.TaggedError('TransportError')<{
  readonly reason: TransportErrorReason
  readonly detail: string
}> {}
