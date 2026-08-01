/**
 * Connection lifecycle, as an explicit state machine.
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * ---------------------------------------------------------------------------
 * Why a machine and not a pair of booleans
 * ---------------------------------------------------------------------------
 *
 * "Connection management" (plan.md §3.14) degenerates into `isConnected` +
 * `isConnecting` + a retry counter unless the legal transitions are written
 * down. Once it does, two states that should be impossible become
 * representable — `connecting && connected`, and `disconnected` while a
 * handshake is still in flight — and the bug they produce is a reconnect
 * storm, which only shows up under a flaky network.
 *
 * `transition` returns `undefined` for an illegal event rather than silently
 * returning the current state. That distinction is the point: a caller that
 * gets `undefined` has found a bug in its own logic, whereas a caller that gets
 * the unchanged state cannot tell "nothing to do" from "you asked for something
 * incoherent".
 */
import type { TransportErrorReason } from './errors'
import type { PlayerId, WorldId } from './protocol'

export type ConnectionState =
  /** Nothing open. The only state from which a connect may be requested. */
  | { readonly _tag: 'Disconnected' }
  /** Socket opening and/or handshake in flight. Sending is not permitted yet. */
  | { readonly _tag: 'Connecting'; readonly attempt: number }
  /** Handshake complete. This is the only state in which frames may be sent. */
  | {
      readonly _tag: 'Connected'
      readonly player: PlayerId
      readonly world: WorldId
    }
  /**
   * Terminal for this attempt. Carries why, so the UI layer (mx-ui) can say
   * something truthful instead of "connection lost".
   */
  | { readonly _tag: 'Closed'; readonly reason: TransportErrorReason }

export type ConnectionEvent =
  | { readonly _tag: 'ConnectRequested' }
  | {
      readonly _tag: 'HandshakeSucceeded'
      readonly player: PlayerId
      readonly world: WorldId
    }
  | { readonly _tag: 'HandshakeFailed' }
  | { readonly _tag: 'PeerClosed' }
  | { readonly _tag: 'TransportFailed'; readonly reason: TransportErrorReason }
  | { readonly _tag: 'CloseRequested' }
  /** Explicit, so a retry cannot be smuggled in as a fresh `ConnectRequested`. */
  | { readonly _tag: 'RetryRequested' }

export const initialConnectionState: ConnectionState = { _tag: 'Disconnected' }

/** Frames may only be sent from `Connected`. Used by the transport and stage gates. */
export const canSend = (state: ConnectionState): boolean => state._tag === 'Connected'

/** True once the attempt has settled, either way. */
export const isSettled = (state: ConnectionState): boolean =>
  state._tag === 'Connected' || state._tag === 'Closed'

/**
 * The transition table. `undefined` means "this event is not legal here".
 *
 * Retry policy is NOT here, on purpose. This function says which states are
 * reachable; how long to wait before `RetryRequested` and how many times is a
 * `Schedule`, and belongs to the adapter that owns the socket. Mixing the two
 * is how a state machine acquires a timer.
 */
export const transition = (
  state: ConnectionState,
  event: ConnectionEvent,
): ConnectionState | undefined => {
  switch (state._tag) {
    case 'Disconnected':
      return event._tag === 'ConnectRequested' ? { _tag: 'Connecting', attempt: 1 } : undefined

    case 'Connecting':
      switch (event._tag) {
        case 'HandshakeSucceeded':
          return { _tag: 'Connected', player: event.player, world: event.world }
        case 'HandshakeFailed':
          return { _tag: 'Closed', reason: 'closed' }
        case 'TransportFailed':
          return { _tag: 'Closed', reason: event.reason }
        case 'PeerClosed':
          return { _tag: 'Closed', reason: 'closed' }
        case 'CloseRequested':
          return { _tag: 'Disconnected' }
        default:
          // A second ConnectRequested while already connecting is the reconnect
          // storm this machine exists to prevent, so it is illegal rather than
          // idempotent: the caller has lost track of its own state.
          return undefined
      }

    case 'Connected':
      switch (event._tag) {
        case 'PeerClosed':
          return { _tag: 'Closed', reason: 'closed' }
        case 'TransportFailed':
          return { _tag: 'Closed', reason: event.reason }
        case 'CloseRequested':
          return { _tag: 'Disconnected' }
        default:
          return undefined
      }

    case 'Closed':
      switch (event._tag) {
        case 'RetryRequested':
          return { _tag: 'Connecting', attempt: 1 }
        case 'CloseRequested':
          return { _tag: 'Disconnected' }
        default:
          return undefined
      }
  }
}

/**
 * Advance through a sequence, stopping at the first illegal event.
 *
 * Returns the reached state plus the index that stopped it, so a test can
 * assert *where* a sequence became incoherent rather than only that it did.
 */
export const runTransitions = (
  from: ConnectionState,
  events: ReadonlyArray<ConnectionEvent>,
): {
  readonly state: ConnectionState
  readonly rejectedAt: number | undefined
} => {
  let state = from
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const next = event === undefined ? undefined : transition(state, event)
    if (next === undefined) {
      return { state, rejectedAt: index }
    }
    state = next
  }
  return { state, rejectedAt: undefined }
}
