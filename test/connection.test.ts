import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  type ConnectionEvent,
  type ConnectionState,
  canSend,
  initialConnectionState,
  isSettled,
  runTransitions,
  transition,
} from '../src/domain/connection'
import { PlayerId, WorldId } from '../src/domain/protocol'

const connectRequested: ConnectionEvent = { _tag: 'ConnectRequested' }
const handshakeSucceeded: ConnectionEvent = {
  _tag: 'HandshakeSucceeded',
  player: PlayerId.make('alice'),
  world: WorldId.make('overworld'),
}
const closeRequested: ConnectionEvent = { _tag: 'CloseRequested' }

const connected: ConnectionState = {
  _tag: 'Connected',
  player: PlayerId.make('alice'),
  world: WorldId.make('overworld'),
}

describe('the happy path', () => {
  it.effect('goes Disconnected -> Connecting -> Connected and carries the identity out of the handshake', () =>
    Effect.sync(() => {
      const { state, rejectedAt } = runTransitions(initialConnectionState, [
        connectRequested,
        handshakeSucceeded,
      ])

      expect(rejectedAt).toBeUndefined()
      expect(state).toStrictEqual(connected)
    }),
  )

  it.effect('permits sending only once connected', () =>
    Effect.sync(() => {
      expect(canSend(initialConnectionState)).toBe(false)
      expect(canSend({ _tag: 'Connecting', attempt: 1 })).toBe(false)
      expect(canSend(connected)).toBe(true)
      expect(canSend({ _tag: 'Closed', reason: 'closed' })).toBe(false)
    }),
  )

  it.effect('treats Connected and Closed as settled, and the two transient states as not', () =>
    Effect.sync(() => {
      expect(isSettled(connected)).toBe(true)
      expect(isSettled({ _tag: 'Closed', reason: 'send-failed' })).toBe(true)
      expect(isSettled(initialConnectionState)).toBe(false)
      expect(isSettled({ _tag: 'Connecting', attempt: 1 })).toBe(false)
    }),
  )
})

describe('illegal transitions', () => {
  // REGRESSION: "a second connect while already connecting is rejected, not
  // Absorbed". Absorbing it is exactly how a reconnect storm is written: every
  // Caller that thinks it might not be connected fires another attempt, and
  // Nothing ever reports that the state was already in flight.
  it.effect('rejects a second ConnectRequested while a handshake is in flight', () =>
    Effect.sync(() => {
      const { state, rejectedAt } = runTransitions(initialConnectionState, [
        connectRequested,
        connectRequested,
      ])

      expect(rejectedAt).toBe(1)
      expect(state).toStrictEqual({ _tag: 'Connecting', attempt: 1 })
    }),
  )

  it.effect('rejects sending-shaped events from Disconnected rather than pretending they happened', () =>
    Effect.sync(() => {
      expect(transition(initialConnectionState, handshakeSucceeded)).toBeUndefined()
      expect(transition(initialConnectionState, { _tag: 'PeerClosed' })).toBeUndefined()
      expect(transition(initialConnectionState, { _tag: 'RetryRequested' })).toBeUndefined()
    }),
  )

  // REGRESSION: "undefined means illegal, the unchanged state means nothing to
  // Do". If `transition` returned the current state for an illegal event, a
  // Caller could not tell the two apart and the machine would be advisory.
  it.effect('returns undefined for an illegal event instead of silently returning the current state', () =>
    Effect.sync(() => {
      expect(transition(connected, connectRequested)).toBeUndefined()
      expect(transition({ _tag: 'Closed', reason: 'closed' }, handshakeSucceeded)).toBeUndefined()
    }),
  )

  it.effect('reports the index at which a sequence became incoherent', () =>
    Effect.sync(() => {
      const { rejectedAt } = runTransitions(initialConnectionState, [
        connectRequested,
        handshakeSucceeded,
        closeRequested,
        handshakeSucceeded,
      ])
      expect(rejectedAt).toBe(3)
    }),
  )
})

describe('failure and retry', () => {
  it.effect('carries the transport failure reason into Closed, so the UI can be truthful about it', () =>
    Effect.sync(() => {
      const { state } = runTransitions(initialConnectionState, [
        connectRequested,
        handshakeSucceeded,
        { _tag: 'TransportFailed', reason: 'send-failed' },
      ])
      expect(state).toStrictEqual({ _tag: 'Closed', reason: 'send-failed' })
    }),
  )

  it.effect('closes with reason "closed" when the peer hangs up mid-handshake or once connected', () =>
    Effect.sync(() => {
      expect(transition({ _tag: 'Connecting', attempt: 1 }, { _tag: 'PeerClosed' })).toStrictEqual({
        _tag: 'Closed',
        reason: 'closed',
      })
      expect(transition(connected, { _tag: 'PeerClosed' })).toStrictEqual({
        _tag: 'Closed',
        reason: 'closed',
      })
    }),
  )

  // REGRESSION: "retry is an explicit event". Reusing ConnectRequested for a
  // Retry would make the machine unable to distinguish a user pressing Join
  // From a schedule firing, and a retry policy would have nowhere to attach.
  it.effect('re-enters Connecting only through RetryRequested, never through ConnectRequested', () =>
    Effect.sync(() => {
      const closed: ConnectionState = { _tag: 'Closed', reason: 'closed' }
      expect(transition(closed, { _tag: 'RetryRequested' })).toStrictEqual({ _tag: 'Connecting', attempt: 1 })
      expect(transition(closed, connectRequested)).toBeUndefined()
    }),
  )

  it.effect('lets a user-requested close return to Disconnected from anywhere it is legal', () =>
    Effect.sync(() => {
      expect(transition({ _tag: 'Connecting', attempt: 1 }, closeRequested)).toStrictEqual({
        _tag: 'Disconnected',
      })
      expect(transition(connected, closeRequested)).toStrictEqual({ _tag: 'Disconnected' })
      expect(transition({ _tag: 'Closed', reason: 'closed' }, closeRequested)).toStrictEqual({
        _tag: 'Disconnected',
      })
    }),
  )

  it.effect('holds no timer, no schedule and no attempt budget — retry policy lives in the adapter', () =>
    Effect.sync(() => {
      // Every state reachable from a fresh machine is a plain data value; the
      // Machine cannot start a timer because it has no Effect in it at all.
      const { state } = runTransitions(initialConnectionState, [
        connectRequested,
        { _tag: 'HandshakeFailed' },
        { _tag: 'RetryRequested' },
      ])
      expect(state).toStrictEqual({ _tag: 'Connecting', attempt: 1 })
    }),
  )
})
