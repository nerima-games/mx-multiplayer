import { describe, expect, it } from '@effect/vitest'
import { isBlockType } from '@nerima-games/mc-kernel'
import { Result, Schema } from 'effect'
import { vi } from 'vitest'
import { BlockPlace } from '../src/domain/protocol.js'

const kernelMocks = vi.hoisted(() => ({
  blockIdOf: vi.fn(),
}))

vi.mock('@nerima-games/mc-kernel', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nerima-games/mc-kernel')>()
  const { Option } = await import('effect')
  kernelMocks.blockIdOf.mockImplementation(() => Option.none())
  return { ...original, blockIdOf: kernelMocks.blockIdOf }
})

describe('BlockPlace block registry boundary', () => {
  it('accepts state through the registry-missing fallback for a recognized block type', () => {
    expect(isBlockType('stone')).toBe(true)

    const decoded = Schema.decodeUnknownResult(BlockPlace)({
      _tag: 'BlockPlace',
      at: { x: 0, y: 0, z: 0 },
      block: 'stone',
      player: 'alice',
      state: 1,
    })

    expect(kernelMocks.blockIdOf).toHaveBeenCalledWith('stone')
    expect(Result.isSuccess(decoded)).toBe(true)
  })
})
