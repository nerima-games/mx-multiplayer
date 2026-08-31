import { describe, expect, it } from '@effect/vitest'
import { frameTag, unknownRecord } from '../src/application/server/frame-inspection'

describe('unknownRecord', () => {
  it('accepts a plain object', () => {
    expect(unknownRecord({ a: 1 })).toStrictEqual({ a: 1 })
  })

  it('rejects null, a primitive, and an array', () => {
    expect(unknownRecord(null)).toBeUndefined()
    expect(unknownRecord('text')).toBeUndefined()
    expect(unknownRecord([1, 2])).toStrictEqual([1, 2])
  })
})

describe('frameTag', () => {
  it('reads the _tag off a well-formed frame', () => {
    expect(frameTag('{"_tag":"Ping","nonce":1}')).toBe('Ping')
  })

  it('returns undefined for text that is not JSON', () => {
    expect(frameTag('not json')).toBeUndefined()
  })

  it('returns undefined for JSON that is not an object', () => {
    expect(frameTag('42')).toBeUndefined()
    expect(frameTag('[1,2,3]')).toBeUndefined()
  })

  it('returns undefined when _tag is missing or not a string', () => {
    expect(frameTag('{"nonce":1}')).toBeUndefined()
    expect(frameTag('{"_tag":7}')).toBeUndefined()
  })
})
