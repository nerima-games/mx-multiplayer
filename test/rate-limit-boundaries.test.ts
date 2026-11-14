/* eslint-disable no-magic-numbers -- These cases pin exact rate-limit thresholds. */
import { describe, expect, it } from '@effect/vitest'
import { Result } from 'effect'
import {
  CONNECTION_RATE_LIMITS,
  MAX_C4_DELTA_FRAME_BYTES,
  createConnectionMessageRateLimiter,
  createConnectionRateLimiter,
} from '../src/index.js'

describe('rate-limit boundaries', () => {
  it('accepts 20 commands and rejects the 21st with a typed kind limit', () => {
    const limiter = createConnectionMessageRateLimiter()
    for (let index = 0; index < 20; index += 1) {
      expect(Result.isSuccess(limiter.consume('command', 0))).toBe(true)
    }

    const exceeded = limiter.consume('command', 0)
    expect(Result.isFailure(exceeded)).toBe(true)
    if (Result.isFailure(exceeded)) {
      expect(exceeded.failure).toMatchObject({
        _tag: 'MessageKindRateLimitExceeded',
        kind: 'command',
        limit: 20,
        reason: 'kind-rate',
      })
    }
  })

  it('accepts 80 other messages and rejects the 81st without consuming the global burst', () => {
    const limiter = createConnectionMessageRateLimiter()
    for (let index = 0; index < 80; index += 1) {
      expect(Result.isSuccess(limiter.consume('other', 0))).toBe(true)
    }

    const exceeded = limiter.consume('other', 0)
    expect(Result.isFailure(exceeded)).toBe(true)
    if (Result.isFailure(exceeded)) {
      expect(exceeded.failure).toMatchObject({
        _tag: 'MessageKindRateLimitExceeded',
        kind: 'other',
        limit: 80,
        reason: 'kind-rate',
      })
    }
  })

  it('enforces the sustained command refill rate at 10 messages per second', () => {
    const limiter = createConnectionMessageRateLimiter()
    for (let index = 0; index < 20; index += 1) {
      expect(Result.isSuccess(limiter.consume('command', 0))).toBe(true)
    }
    for (let interval = 1; interval <= 10; interval += 1) {
      expect(Result.isSuccess(limiter.consume('command', interval * 100))).toBe(true)
    }

    const exceeded = limiter.consume('command', 1_000)
    expect(Result.isFailure(exceeded)).toBe(true)
    if (Result.isFailure(exceeded)) {
      expect(exceeded.failure).toMatchObject({
        _tag: 'MessageKindRateLimitExceeded',
        kind: 'command',
        reason: 'kind-rate',
      })
    }
  })

  it('allows exactly the configured bytes per second and returns a typed byte-rate failure above it', () => {
    const limiter = Result.getOrThrow(createConnectionRateLimiter({
      framesPerSecond: 100,
      bytesPerSecond: 100,
      burstFrames: 100,
      maxDeltaBytes: 100,
    }))

    expect(Result.isSuccess(limiter.consume(100, 0))).toBe(true)
    expect(Result.isSuccess(limiter.consume(100, 1_000))).toBe(true)
    const exceeded = limiter.consume(1, 1_000)
    expect(Result.isFailure(exceeded)).toBe(true)
    if (Result.isFailure(exceeded)) {
      expect(exceeded.failure).toMatchObject({
        _tag: 'RateLimitExceeded',
        reason: 'byte-rate',
        requested: 1,
        limit: 100,
      })
    }
  })

  it('accepts a delta of 54,489 bytes and rejects one byte more', () => {
    const exact = Result.getOrThrow(createConnectionRateLimiter(CONNECTION_RATE_LIMITS))
    const oversized = Result.getOrThrow(createConnectionRateLimiter(CONNECTION_RATE_LIMITS))

    expect(MAX_C4_DELTA_FRAME_BYTES).toBe(54_489)
    expect(Result.isSuccess(exact.consume(MAX_C4_DELTA_FRAME_BYTES, 0))).toBe(true)
    const exceeded = oversized.consume(MAX_C4_DELTA_FRAME_BYTES + 1, 0)
    expect(Result.isFailure(exceeded)).toBe(true)
    if (Result.isFailure(exceeded)) {
      expect(exceeded.failure).toMatchObject({
        _tag: 'RateLimitExceeded',
        reason: 'delta-too-large',
        requested: 54_490,
        limit: 54_489,
      })
    }
  })
})
