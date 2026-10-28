import type {
  AuthoritativeResyncRequest,
  Base64,
  NetworkMessage as NetworkMessageType,
  ReplicatedWorldDeltaMessage,
  ReplicatedWorldSnapshot,
  ReplicatedWorldSnapshotChunk,
  ReplicatedWorldSnapshotEnd,
  ReplicatedWorldSnapshotStart,
  WorldId,
  WorldSnapshot,
} from './protocol.js'
import { ProtocolError, SnapshotTransferConfigError } from './errors.js'
import type { ReplicatedBlockChange, ReplicatedOwnerChange, WorldBlockRead } from '@nerima-games/mc-sim'
import { type ReplicatedOwnerRegistry, decodeTransferredSnapshotFrame } from './codec.js'
import { Result } from 'effect'
import type { WorldRevision } from '@nerima-games/mc-kernel'

const ZERO = 0
const ONE = 1
const TWO = 2
const THREE = 3
const FOUR = 4
const SIX = 6
const SEVEN = 7
const EIGHT = 8
const TEN = 10
const TWELVE = 12
const THIRTEEN = 13
const SIXTEEN = 16
const EIGHTEEN = 18
const TWENTY_TWO = 22
const TWENTY_FIVE = 25
const THIRTY_TWO = 32
const SHA256_INITIAL_SCHEDULE_WORDS = SIXTEEN
const SHA256_IV_A = 0x6a09e667
const SHA256_IV_B = 0xbb67ae85
const SHA256_IV_C = 0x3c6ef372
const SHA256_IV_D = 0xa54ff53a
const SHA256_IV_E = 0x510e527f
const SHA256_IV_F = 0x9b05688c
const SHA256_IV_G = 0x1f83d9ab
const SHA256_IV_H = 0x5be0cd19
const SHA256_ROUND_00 = 0x428a2f98
const SHA256_ROUND_01 = 0x71374491
const SHA256_ROUND_02 = 0xb5c0fbcf
const SHA256_ROUND_03 = 0xe9b5dba5
const SHA256_ROUND_04 = 0x3956c25b
const SHA256_ROUND_05 = 0x59f111f1
const SHA256_ROUND_06 = 0x923f82a4
const SHA256_ROUND_07 = 0xab1c5ed5
const SHA256_ROUND_08 = 0xd807aa98
const SHA256_ROUND_09 = 0x12835b01
const SHA256_ROUND_10 = 0x243185be
const SHA256_ROUND_11 = 0x550c7dc3
const SHA256_ROUND_12 = 0x72be5d74
const SHA256_ROUND_13 = 0x80deb1fe
const SHA256_ROUND_14 = 0x9bdc06a7
const SHA256_ROUND_15 = 0xc19bf174
const SHA256_ROUND_16 = 0xe49b69c1
const SHA256_ROUND_17 = 0xefbe4786
const SHA256_ROUND_18 = 0x0fc19dc6
const SHA256_ROUND_19 = 0x240ca1cc
const SHA256_ROUND_20 = 0x2de92c6f
const SHA256_ROUND_21 = 0x4a7484aa
const SHA256_ROUND_22 = 0x5cb0a9dc
const SHA256_ROUND_23 = 0x76f988da
const SHA256_ROUND_24 = 0x983e5152
const SHA256_ROUND_25 = 0xa831c66d
const SHA256_ROUND_26 = 0xb00327c8
const SHA256_ROUND_27 = 0xbf597fc7
const SHA256_ROUND_28 = 0xc6e00bf3
const SHA256_ROUND_29 = 0xd5a79147
const SHA256_ROUND_30 = 0x06ca6351
const SHA256_ROUND_31 = 0x14292967
const SHA256_ROUND_32 = 0x27b70a85
const SHA256_ROUND_33 = 0x2e1b2138
const SHA256_ROUND_34 = 0x4d2c6dfc
const SHA256_ROUND_35 = 0x53380d13
const SHA256_ROUND_36 = 0x650a7354
const SHA256_ROUND_37 = 0x766a0abb
const SHA256_ROUND_38 = 0x81c2c92e
const SHA256_ROUND_39 = 0x92722c85
const SHA256_ROUND_40 = 0xa2bfe8a1
const SHA256_ROUND_41 = 0xa81a664b
const SHA256_ROUND_42 = 0xc24b8b70
const SHA256_ROUND_43 = 0xc76c51a3
const SHA256_ROUND_44 = 0xd192e819
const SHA256_ROUND_45 = 0xd6990624
const SHA256_ROUND_46 = 0xf40e3585
const SHA256_ROUND_47 = 0x106aa070
const SHA256_ROUND_48 = 0x19a4c116
const SHA256_ROUND_49 = 0x1e376c08
const SHA256_ROUND_50 = 0x2748774c
const SHA256_ROUND_51 = 0x34b0bcb5
const SHA256_ROUND_52 = 0x391c0cb3
const SHA256_ROUND_53 = 0x4ed8aa4a
const SHA256_ROUND_54 = 0x5b9cca4f
const SHA256_ROUND_55 = 0x682e6ff3
const SHA256_ROUND_56 = 0x748f82ee
const SHA256_ROUND_57 = 0x78a5636f
const SHA256_ROUND_58 = 0x84c87814
const SHA256_ROUND_59 = 0x8cc70208
const SHA256_ROUND_60 = 0x90befffa
const SHA256_ROUND_61 = 0xa4506ceb
const SHA256_ROUND_62 = 0xbef9a3f7
const SHA256_ROUND_63 = 0xc67178f2
const SHA256_ROUND_CONSTANTS = [
  SHA256_ROUND_00, SHA256_ROUND_01, SHA256_ROUND_02, SHA256_ROUND_03,
  SHA256_ROUND_04, SHA256_ROUND_05, SHA256_ROUND_06, SHA256_ROUND_07,
  SHA256_ROUND_08, SHA256_ROUND_09, SHA256_ROUND_10, SHA256_ROUND_11,
  SHA256_ROUND_12, SHA256_ROUND_13, SHA256_ROUND_14, SHA256_ROUND_15,
  SHA256_ROUND_16, SHA256_ROUND_17, SHA256_ROUND_18, SHA256_ROUND_19,
  SHA256_ROUND_20, SHA256_ROUND_21, SHA256_ROUND_22, SHA256_ROUND_23,
  SHA256_ROUND_24, SHA256_ROUND_25, SHA256_ROUND_26, SHA256_ROUND_27,
  SHA256_ROUND_28, SHA256_ROUND_29, SHA256_ROUND_30, SHA256_ROUND_31,
  SHA256_ROUND_32, SHA256_ROUND_33, SHA256_ROUND_34, SHA256_ROUND_35,
  SHA256_ROUND_36, SHA256_ROUND_37, SHA256_ROUND_38, SHA256_ROUND_39,
  SHA256_ROUND_40, SHA256_ROUND_41, SHA256_ROUND_42, SHA256_ROUND_43,
  SHA256_ROUND_44, SHA256_ROUND_45, SHA256_ROUND_46, SHA256_ROUND_47,
  SHA256_ROUND_48, SHA256_ROUND_49, SHA256_ROUND_50, SHA256_ROUND_51,
  SHA256_ROUND_52, SHA256_ROUND_53, SHA256_ROUND_54, SHA256_ROUND_55,
  SHA256_ROUND_56, SHA256_ROUND_57, SHA256_ROUND_58, SHA256_ROUND_59,
  SHA256_ROUND_60, SHA256_ROUND_61, SHA256_ROUND_62, SHA256_ROUND_63,
]
const SHA256_BLOCK_BYTES = 64
const SHA256_SCHEDULE_WORDS = 64
const SHA256_FINAL_LENGTH_BYTES = EIGHT
const SHA256_MARKER_BYTES = ONE
const SHA256_PADDING_MARKER = 0x80
const UINT32_MODULUS = 0x1_0000_0000
const UINT32_MAX = UINT32_MODULUS - ONE
const UINT32_BYTE_BASE = 256
const UINT32_BYTE_HIGH_PLACE = 0x1_000_000
const UINT32_BYTE_MIDDLE_HIGH_PLACE = 0x1_0000
const UINT32_BYTE_MIDDLE_LOW_PLACE = 0x100
const BINARY_BASE = TWO
const NIBBLE_BITS = FOUR
const NIBBLE_BASE = BINARY_BASE ** NIBBLE_BITS
const NIBBLE_COUNT = THIRTY_TWO / NIBBLE_BITS
const NIBBLE_TABLE_SIZE = NIBBLE_BASE * NIBBLE_BASE
const HEX_RADIX = SIXTEEN
const SHA256_HEX_WORD_WIDTH = EIGHT
const SHA256_INITIAL_A = 0
const SHA256_INITIAL_B = 1
const SHA256_INITIAL_C = 2
const SHA256_INITIAL_D = 3
const SHA256_INITIAL_E = 4
const SHA256_INITIAL_F = 5
const SHA256_INITIAL_G = 6
const SHA256_INITIAL_H = 7
const SHA256_SIGMA0_ROTATE_A = SEVEN
const SHA256_SIGMA0_ROTATE_B = EIGHTEEN
const SHA256_SIGMA0_SHIFT = THREE
const SHA256_SIGMA1_ROTATE_A = 17
const SHA256_SIGMA1_ROTATE_B = 19
const SHA256_SIGMA1_SHIFT = TEN
const SHA256_SUM1_ROTATE_A = SIX
const SHA256_SUM1_ROTATE_B = 11
const SHA256_SUM1_ROTATE_C = TWENTY_FIVE
const SHA256_SUM0_ROTATE_A = TWO
const SHA256_SUM0_ROTATE_B = THIRTEEN
const SHA256_SUM0_ROTATE_C = TWENTY_TWO
const SHA256_PREVIOUS_15_WORDS = 15
const SHA256_PREVIOUS_7_WORDS = SEVEN
const SHA256_PREVIOUS_16_WORDS = SIXTEEN
const BASE64_QUARTET_LENGTH = FOUR
const BASE64_BYTES_PER_QUARTET = THREE
const BASE64_TWO_PADDING = '=='
const BASE64_ONE_PADDING = '='
const BASE64_PADDING_TWO_LENGTH = TWO
const BASE64_PADDING_ONE_LENGTH = ONE
const BASE64_NO_PADDING = ZERO
const BASE64_UNUSED_TWO_PADDING_BITS = FOUR
const BASE64_UNUSED_ONE_PADDING_BITS = TWO
const BASE64_PACKED_FIRST_SHIFT = EIGHTEEN
const BASE64_PACKED_SECOND_SHIFT = TWELVE
const BASE64_PACKED_THIRD_SHIFT = SIX
const BASE64_BYTE_BASE = UINT32_BYTE_BASE
const BASE64_BYTE_HIGH_PLACE = UINT32_BYTE_MIDDLE_HIGH_PLACE
const BASE64_BYTE_MIDDLE_PLACE = UINT32_BYTE_BASE
const UTF8_CONTINUATION_START = 0x80
const UTF8_CONTINUATION_END = 0xbf
const UTF8_TWO_BYTE_START = 0xc2
const UTF8_TWO_BYTE_END = 0xdf
const UTF8_THREE_BYTE_START = 0xe0
const UTF8_THREE_BYTE_END = 0xef
const UTF8_FOUR_BYTE_START = 0xf0
const UTF8_FOUR_BYTE_END = 0xf4
const UTF8_TWO_BYTE_PREFIX_MODULUS = 0x20
const UTF8_THREE_BYTE_PREFIX_MODULUS = 0x10
const UTF8_FOUR_BYTE_PREFIX_MODULUS = 0x08
const UTF8_TWO_BYTE_SCALE = 0x40
const UTF8_THREE_BYTE_HIGH_SCALE = 0x1000
const UTF8_THREE_BYTE_MIDDLE_SCALE = 0x40
const UTF8_FOUR_BYTE_HIGH_SCALE = 0x40000
const UTF8_FOUR_BYTE_MIDDLE_HIGH_SCALE = 0x1000
const UTF8_FOUR_BYTE_MIDDLE_LOW_SCALE = 0x40
const UTF8_PAYLOAD_MODULUS = 0x40
const UTF8_THREE_BYTE_MIN_START = 0xa0
const UTF8_THREE_BYTE_MAX_END = 0x9f
const UTF8_FOUR_BYTE_MIN_START = 0x90
const UTF8_FOUR_BYTE_MAX_END = 0x8f
const UTF8_MAX_CODE_POINT = 0x10ffff
const UTF8_SURROGATE_START = 0xed
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

type BitOperation = 'and' | 'xor'
type Sha256State = [number, number, number, number, number, number, number, number]
type Utf8CodePoint = Readonly<{ readonly codePoint: number; readonly width: number }>
type Sha256Padding = Readonly<{ readonly paddedLength: number; readonly bitLength: number }>
type Base64PackedOutput = Readonly<{
  readonly output: Uint8Array
  readonly outputIndex: number
  readonly decodedLength: number
  readonly packed: number
}>
type Base64OutputByte = Readonly<{
  readonly output: Uint8Array
  readonly index: number
  readonly decodedLength: number
  readonly value: number
}>

const bufferByte = (bytes: Uint8Array, index: number): number => bytes[index] ?? ZERO

const nibbleBitOperation = (left: number, right: number, operation: BitOperation): number => {
  if (operation === 'and') {
    return Number(left === ONE && right === ONE)
  }
  return Number(left !== right)
}

const combineNibbleValues = (left: number, right: number, operation: BitOperation): number => {
  let output = ZERO
  for (let bit = ZERO; bit < NIBBLE_BITS; bit += ONE) {
    const leftBit = Math.floor(left / (BINARY_BASE ** bit)) % BINARY_BASE
    const rightBit = Math.floor(right / (BINARY_BASE ** bit)) % BINARY_BASE
    output += nibbleBitOperation(leftBit, rightBit, operation) * (BINARY_BASE ** bit)
  }
  return output
}

const makeNibbleOperationTable = (operation: BitOperation): Uint8Array => {
  const table = new Uint8Array(NIBBLE_TABLE_SIZE)
  for (let left = ZERO; left < NIBBLE_BASE; left += ONE) {
    for (let right = ZERO; right < NIBBLE_BASE; right += ONE) {
      table[left * NIBBLE_BASE + right] = combineNibbleValues(left, right, operation)
    }
  }
  return table
}

const UINT32_AND_TABLE = makeNibbleOperationTable('and')
const UINT32_XOR_TABLE = makeNibbleOperationTable('xor')

const combineUint32 = (left: number, right: number, table: Uint8Array): number => {
  let output = ZERO
  let place = ONE
  for (let index = ZERO; index < NIBBLE_COUNT; index += ONE) {
    const leftNibble = Math.floor(left / place) % NIBBLE_BASE
    const rightNibble = Math.floor(right / place) % NIBBLE_BASE
    const tableIndex = leftNibble * NIBBLE_BASE + rightNibble
    output += (table[tableIndex] || ZERO) * place
    place *= NIBBLE_BASE
  }
  return output
}

const andUint32 = (left: number, right: number): number => combineUint32(left, right, UINT32_AND_TABLE)
const xorUint32 = (left: number, right: number): number => combineUint32(left, right, UINT32_XOR_TABLE)
const xorThreeUint32 = (first: number, second: number, third: number): number =>
  xorUint32(xorUint32(first, second), third)
const invertUint32 = (value: number): number => UINT32_MAX - value
const addUint32 = (left: number, right: number): number => (left + right) % UINT32_MODULUS
const shiftRightUint32 = (value: number, count: number): number => Math.floor(value / (BINARY_BASE ** count))
const shiftLeftUint32 = (value: number, count: number): number => {
  const shift = BINARY_BASE ** count
  const reducedValue = value % (UINT32_MODULUS / shift)
  return reducedValue * shift
}
const rotateRightUint32 = (value: number, count: number): number =>
  (shiftRightUint32(value, count) + shiftLeftUint32(value, THIRTY_TWO - count)) % UINT32_MODULUS

const readUint32BigEndian = (bytes: Uint8Array, offset: number): number =>
  bufferByte(bytes, offset) * UINT32_BYTE_HIGH_PLACE +
  bufferByte(bytes, offset + ONE) * UINT32_BYTE_MIDDLE_HIGH_PLACE +
  bufferByte(bytes, offset + TWO) * UINT32_BYTE_MIDDLE_LOW_PLACE +
  bufferByte(bytes, offset + THREE)

const writeUint32BigEndian = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = Math.floor(value / UINT32_BYTE_HIGH_PLACE) % UINT32_BYTE_BASE
  bytes[offset + ONE] = Math.floor(value / UINT32_BYTE_MIDDLE_HIGH_PLACE) % UINT32_BYTE_BASE
  bytes[offset + TWO] = Math.floor(value / UINT32_BYTE_MIDDLE_LOW_PLACE) % UINT32_BYTE_BASE
  bytes[offset + THREE] = value % UINT32_BYTE_BASE
}

const extendSha256Schedule = (schedule: Uint32Array): void => {
  for (let index = SHA256_INITIAL_SCHEDULE_WORDS; index < SHA256_SCHEDULE_WORDS; index += ONE) {
    const previous15 = schedule[index - SHA256_PREVIOUS_15_WORDS] || ZERO
    const previous2 = schedule[index - TWO] || ZERO
    const smallSigma0 = xorThreeUint32(
      rotateRightUint32(previous15, SHA256_SIGMA0_ROTATE_A),
      rotateRightUint32(previous15, SHA256_SIGMA0_ROTATE_B),
      shiftRightUint32(previous15, SHA256_SIGMA0_SHIFT),
    )
    const smallSigma1 = xorThreeUint32(
      rotateRightUint32(previous2, SHA256_SIGMA1_ROTATE_A),
      rotateRightUint32(previous2, SHA256_SIGMA1_ROTATE_B),
      shiftRightUint32(previous2, SHA256_SIGMA1_SHIFT),
    )
    schedule[index] = addUint32(
      addUint32(schedule[index - SHA256_PREVIOUS_16_WORDS] || ZERO, smallSigma0),
      addUint32(schedule[index - SHA256_PREVIOUS_7_WORDS] || ZERO, smallSigma1),
    )
  }
}

const sha256Round = (state: Sha256State, constant: number, word: number): Sha256State => {
  const [stateA, stateB, stateC, stateD, stateE, stateF, stateG, stateH] = state
  const sum1 = xorThreeUint32(
    rotateRightUint32(stateE, SHA256_SUM1_ROTATE_A),
    rotateRightUint32(stateE, SHA256_SUM1_ROTATE_B),
    rotateRightUint32(stateE, SHA256_SUM1_ROTATE_C),
  )
  const choose = xorUint32(andUint32(stateE, stateF), andUint32(invertUint32(stateE), stateG))
  const temp1 = [stateH, sum1, choose, constant, word].reduce(addUint32, ZERO)
  const sum0 = xorThreeUint32(
    rotateRightUint32(stateA, SHA256_SUM0_ROTATE_A),
    rotateRightUint32(stateA, SHA256_SUM0_ROTATE_B),
    rotateRightUint32(stateA, SHA256_SUM0_ROTATE_C),
  )
  const majority = xorThreeUint32(andUint32(stateA, stateB), andUint32(stateA, stateC), andUint32(stateB, stateC))
  const temp2 = addUint32(sum0, majority)
  return [addUint32(temp1, temp2), stateA, stateB, stateC, addUint32(stateD, temp1), stateE, stateF, stateG]
}

const compressSha256Block = (state: Sha256State, block: Uint8Array): Sha256State => {
  const schedule = new Uint32Array(SHA256_SCHEDULE_WORDS)
  for (let index = ZERO; index < SHA256_INITIAL_SCHEDULE_WORDS; index += ONE) {
    schedule[index] = readUint32BigEndian(block, index * FOUR)
  }
  extendSha256Schedule(schedule)

  let workingState = state
  for (const [round, constant] of SHA256_ROUND_CONSTANTS.entries()) {
    const word = schedule[round] || ZERO
    workingState = sha256Round(workingState, constant, word)
  }
  return [
    addUint32(state[SHA256_INITIAL_A], workingState[SHA256_INITIAL_A]),
    addUint32(state[SHA256_INITIAL_B], workingState[SHA256_INITIAL_B]),
    addUint32(state[SHA256_INITIAL_C], workingState[SHA256_INITIAL_C]),
    addUint32(state[SHA256_INITIAL_D], workingState[SHA256_INITIAL_D]),
    addUint32(state[SHA256_INITIAL_E], workingState[SHA256_INITIAL_E]),
    addUint32(state[SHA256_INITIAL_F], workingState[SHA256_INITIAL_F]),
    addUint32(state[SHA256_INITIAL_G], workingState[SHA256_INITIAL_G]),
    addUint32(state[SHA256_INITIAL_H], workingState[SHA256_INITIAL_H]),
  ]
}

const addSha256BlockPadding = (input: Readonly<{
  readonly block: Uint8Array
  readonly bytesLength: number
  readonly blockStart: number
  readonly padding: Sha256Padding
}>): void => {
  const { block, bytesLength, blockStart, padding } = input
  if (blockStart <= bytesLength && bytesLength < blockStart + SHA256_BLOCK_BYTES) {
    block[bytesLength - blockStart] = SHA256_PADDING_MARKER
  }
  if (blockStart + SHA256_BLOCK_BYTES === padding.paddedLength) {
    const highLength = Math.floor(padding.bitLength / UINT32_MODULUS)
    const lowLength = padding.bitLength % UINT32_MODULUS
    const lengthOffset = SHA256_BLOCK_BYTES - SHA256_FINAL_LENGTH_BYTES
    writeUint32BigEndian(block, lengthOffset, highLength)
    writeUint32BigEndian(block, lengthOffset + FOUR, lowLength)
  }
}

const prepareSha256Block = (bytes: Uint8Array, blockStart: number, padding: Sha256Padding): Uint8Array => {
  const block = new Uint8Array(SHA256_BLOCK_BYTES)
  const remainingBytes = Math.max(ZERO, Math.min(SHA256_BLOCK_BYTES, bytes.length - blockStart))
  for (let index = ZERO; index < remainingBytes; index += ONE) {
    block[index] = bufferByte(bytes, blockStart + index)
  }
  addSha256BlockPadding({ block, blockStart, bytesLength: bytes.length, padding })
  return block
}

const makeSha256InitialState = (): Sha256State => [
  SHA256_IV_A,
  SHA256_IV_B,
  SHA256_IV_C,
  SHA256_IV_D,
  SHA256_IV_E,
  SHA256_IV_F,
  SHA256_IV_G,
  SHA256_IV_H,
]

/** SHA-256 without a platform dependency or a second full-size padded copy. */
export const sha256Hex = (bytes: Uint8Array): string => {
  let state = makeSha256InitialState()
  const paddedLength = Math.ceil((bytes.length + SHA256_FINAL_LENGTH_BYTES + SHA256_MARKER_BYTES) / SHA256_BLOCK_BYTES) * SHA256_BLOCK_BYTES
  const bitLength = bytes.length * EIGHT
  const padding = { bitLength, paddedLength }
  for (let blockStart = 0; blockStart < paddedLength; blockStart += SHA256_BLOCK_BYTES) {
    const block = prepareSha256Block(bytes, blockStart, padding)
    state = compressSha256Block(state, block)
  }
  return state.map((word) => word.toString(HEX_RADIX).padStart(SHA256_HEX_WORD_WIDTH, '0')).join('')
}

const base64Value = (data: string, index: number): number => BASE64_ALPHABET.indexOf(data.charAt(index))

const base64PaddingLength = (data: string): number => {
  if (data.endsWith(BASE64_TWO_PADDING)) {
    return BASE64_PADDING_TWO_LENGTH
  }
  if (data.endsWith(BASE64_ONE_PADDING)) {
    return BASE64_PADDING_ONE_LENGTH
  }
  return BASE64_NO_PADDING
}

const isCanonicalBase64Padding = (data: string, lastQuartet: number, padding: number): boolean => {
  if (padding === BASE64_PADDING_TWO_LENGTH) {
    const hasTwoPaddingCharacters =
      data.charAt(lastQuartet + TWO) === BASE64_ONE_PADDING &&
      data.charAt(lastQuartet + THREE) === BASE64_ONE_PADDING
    const unusedBitsAreClear = base64Value(data, lastQuartet + ONE) % (BINARY_BASE ** BASE64_UNUSED_TWO_PADDING_BITS) === ZERO
    return hasTwoPaddingCharacters && unusedBitsAreClear
  }
  if (padding === BASE64_PADDING_ONE_LENGTH) {
    const hasOnePaddingCharacter = data.charAt(lastQuartet + THREE) === BASE64_ONE_PADDING
    const unusedBitsAreClear = base64Value(data, lastQuartet + TWO) % (BINARY_BASE ** BASE64_UNUSED_ONE_PADDING_BITS) === ZERO
    return hasOnePaddingCharacter && unusedBitsAreClear
  }
  return true
}

const isCanonicalBase64Data = (data: string, contentEnd: number): boolean => {
  for (let index = ZERO; index < contentEnd; index += ONE) {
    const value = base64Value(data, index)
    if (value < ZERO) {
      return false
    }
  }
  return true
}

const isValidBase64Body = (data: string, lastQuartet: number, padding: number): boolean =>
  isCanonicalBase64Data(data, data.length - padding) && isCanonicalBase64Padding(data, lastQuartet, padding)

type Base64FragmentShape = Readonly<{ readonly decodedLength: number; readonly lastQuartet: number }>

const inspectBase64Fragment = (data: string, maxBytes: number): Base64FragmentShape | undefined => {
  if (data.length === ZERO || data.length % BASE64_QUARTET_LENGTH !== ZERO) {
    return undefined
  }
  const padding = base64PaddingLength(data)
  const decodedLength = (data.length / BASE64_QUARTET_LENGTH) * BASE64_BYTES_PER_QUARTET - padding
  if (decodedLength <= ZERO || decodedLength > maxBytes) {
    return undefined
  }
  const lastQuartet = data.length - BASE64_QUARTET_LENGTH
  if (!isValidBase64Body(data, lastQuartet, padding)) {
    return undefined
  }
  return { decodedLength, lastQuartet }
}

const readBase64ValueOrPaddingZero = (data: string, index: number): number => {
  if (data.charAt(index) === BASE64_ONE_PADDING) {
    return ZERO
  }
  return base64Value(data, index)
}

const decodeBase64Quartet = (data: string, offset: number): number => {
  const first = base64Value(data, offset)
  const second = base64Value(data, offset + ONE)
  const third = readBase64ValueOrPaddingZero(data, offset + TWO)
  const fourth = readBase64ValueOrPaddingZero(data, offset + THREE)
  return first * (BINARY_BASE ** BASE64_PACKED_FIRST_SHIFT) +
    second * (BINARY_BASE ** BASE64_PACKED_SECOND_SHIFT) +
    third * (BINARY_BASE ** BASE64_PACKED_THIRD_SHIFT) +
    fourth
}

const writeBase64Byte = (input: Base64OutputByte): number => {
  if (input.index >= input.decodedLength) {
    return input.index
  }
  input.output[input.index] = input.value
  return input.index + ONE
}

const writeBase64PackedBytes = (input: Base64PackedOutput): number => {
  const { output, outputIndex, decodedLength, packed } = input
  const afterHighByte = writeBase64Byte({
    decodedLength,
    index: outputIndex,
    output,
    value: Math.floor(packed / BASE64_BYTE_HIGH_PLACE) % BASE64_BYTE_BASE,
  })
  const afterMiddleByte = writeBase64Byte({
    decodedLength,
    index: afterHighByte,
    output,
    value: Math.floor(packed / BASE64_BYTE_MIDDLE_PLACE) % BASE64_BYTE_BASE,
  })
  return writeBase64Byte({ decodedLength, index: afterMiddleByte, output, value: packed % BASE64_BYTE_BASE })
}

const decodeBase64Body = (data: Base64, output: Uint8Array, shape: Base64FragmentShape): void => {
  let outputIndex = ZERO
  for (let offset = ZERO; offset < data.length; offset += BASE64_QUARTET_LENGTH) {
    const packed = decodeBase64Quartet(data, offset)
    outputIndex = writeBase64PackedBytes({ decodedLength: shape.decodedLength, output, outputIndex, packed })
  }
}

const decodeBase64Fragment = (data: Base64, maxBytes: number): Uint8Array | undefined => {
  const shape = inspectBase64Fragment(data, maxBytes)
  if (shape === undefined) {
    return undefined
  }
  const output = new Uint8Array(shape.decodedLength)
  decodeBase64Body(data, output, shape)
  return output
}

const isContinuationByte = (value: number): boolean =>
  value >= UTF8_CONTINUATION_START && value <= UTF8_CONTINUATION_END

const decodeTwoByteCodePoint = (first: number, second: number): Utf8CodePoint | undefined => {
  if (!isContinuationByte(second)) {
    return undefined
  }
  const codePoint = (first % UTF8_TWO_BYTE_PREFIX_MODULUS) * UTF8_TWO_BYTE_SCALE +
    second % UTF8_PAYLOAD_MODULUS
  return { codePoint, width: TWO }
}

const decodeThreeByteCodePoint = (first: number, second: number, third: number): Utf8CodePoint | undefined => {
  const secondIsValid = isContinuationByte(second) &&
    (first !== UTF8_THREE_BYTE_START || second >= UTF8_THREE_BYTE_MIN_START) &&
    (first !== UTF8_SURROGATE_START || second <= UTF8_THREE_BYTE_MAX_END)
  if (!secondIsValid || !isContinuationByte(third)) {
    return undefined
  }
  const codePoint = (first % UTF8_THREE_BYTE_PREFIX_MODULUS) * UTF8_THREE_BYTE_HIGH_SCALE +
    (second % UTF8_PAYLOAD_MODULUS) * UTF8_THREE_BYTE_MIDDLE_SCALE +
    third % UTF8_PAYLOAD_MODULUS
  return { codePoint, width: THREE }
}

const decodeFourByteCodePoint = (bytes: readonly [number, number, number, number]): Utf8CodePoint | undefined => {
  const [first, second, third, fourth] = bytes
  const secondIsValid = isContinuationByte(second) &&
    (first !== UTF8_FOUR_BYTE_START || second >= UTF8_FOUR_BYTE_MIN_START) &&
    (first !== UTF8_FOUR_BYTE_END || second <= UTF8_FOUR_BYTE_MAX_END)
  if (!secondIsValid || !isContinuationByte(third) || !isContinuationByte(fourth)) {
    return undefined
  }
  const codePoint = (first % UTF8_FOUR_BYTE_PREFIX_MODULUS) * UTF8_FOUR_BYTE_HIGH_SCALE +
    (second % UTF8_PAYLOAD_MODULUS) * UTF8_FOUR_BYTE_MIDDLE_HIGH_SCALE +
    (third % UTF8_PAYLOAD_MODULUS) * UTF8_FOUR_BYTE_MIDDLE_LOW_SCALE +
    fourth % UTF8_PAYLOAD_MODULUS
  return { codePoint, width: FOUR }
}

const decodeUtf8CodePoint = (bytes: Uint8Array, offset: number): Utf8CodePoint | undefined => {
  const first = bufferByte(bytes, offset)
  if (first >= UTF8_TWO_BYTE_START && first <= UTF8_TWO_BYTE_END) {
    return decodeTwoByteCodePoint(first, bufferByte(bytes, offset + ONE))
  }
  if (first >= UTF8_THREE_BYTE_START && first <= UTF8_THREE_BYTE_END) {
    return decodeThreeByteCodePoint(first, bufferByte(bytes, offset + ONE), bufferByte(bytes, offset + TWO))
  }
  if (first >= UTF8_FOUR_BYTE_START && first <= UTF8_FOUR_BYTE_END) {
    return decodeFourByteCodePoint([
      first,
      bufferByte(bytes, offset + ONE),
      bufferByte(bytes, offset + TWO),
      bufferByte(bytes, offset + THREE),
    ])
  }
  if (first >= UTF8_CONTINUATION_START) {
    return undefined
  }
  return { codePoint: first, width: ONE }
}

/** Decode UTF-8 without replacement characters, so malformed bytes cannot become a different JSON frame. */
export const decodeUtf8Frame = (bytes: Uint8Array): string | undefined => {
  const characters: Array<string> = []
  for (let offset = ZERO; offset < bytes.length;) {
    const decoded = decodeUtf8CodePoint(bytes, offset)
    if (decoded === undefined || decoded.codePoint > UTF8_MAX_CODE_POINT) {
      return undefined
    }
    characters.push(String.fromCodePoint(decoded.codePoint))
    offset += decoded.width
  }
  return characters.join('')
}

export type SnapshotTransferLimits = Readonly<{
  readonly maxTotalBytes: number
  readonly maxChunkCount: number
  readonly maxChunkBytes: number
  readonly maxQueuedDeltaCount: number
  readonly maxQueuedDeltaBytes: number
}>

export type SnapshotTransferFailureReason =
  | 'transfer-already-active'
  | 'invalid-declaration'
  | 'unexpected-transfer-frame'
  | 'wrong-transfer-id'
  | 'world-mismatch'
  | 'chunk-out-of-order'
  | 'chunk-too-large'
  | 'transfer-byte-overflow'
  | 'delta-queue-overflow'
  | 'incomplete-transfer'
  | 'digest-mismatch'

export type SnapshotTransferFailure = Readonly<{
  readonly accepted: false
  readonly reason: SnapshotTransferFailureReason
  readonly request?: AuthoritativeResyncRequest
}>

export type SnapshotTransferReceipt = Readonly<{ readonly accepted: true }> | SnapshotTransferFailure

export type QueuedReplicatedDelta = Readonly<{
  readonly delta: ReplicatedWorldDeltaMessage
  readonly frameBytes: number
}>

export type CompletedSnapshotTransfer = Readonly<{
  readonly world: WorldId
  readonly revision: WorldRevision
  readonly lastKnownRevision: WorldRevision | undefined
  readonly frameBytes: Uint8Array
  readonly maxTotalBytes: number
  readonly queuedDeltas: ReadonlyArray<QueuedReplicatedDelta>
}>

export type SnapshotTransferCompletion =
  | Readonly<{ readonly accepted: true; readonly completion: CompletedSnapshotTransfer }>
  | SnapshotTransferFailure

type ActiveSnapshotTransfer = {
  readonly start: ReplicatedWorldSnapshotStart
  readonly buffer: Uint8Array
  readonly lastKnownRevision: WorldRevision | undefined
  readonly queuedDeltas: Array<QueuedReplicatedDelta>
  queuedDeltaBytes: number
  receivedBytes: number
  nextIndex: number
}

type SnapshotChunkValidation =
  | Readonly<{ readonly accepted: true; readonly fragment: Uint8Array }>
  | Readonly<{ readonly accepted: false; readonly reason: SnapshotTransferFailureReason }>

const isPositiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > ZERO
const isNonNegativeSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= ZERO

const hasValidTransferLimits = (limits: SnapshotTransferLimits): boolean =>
  isPositiveSafeInteger(limits.maxTotalBytes) &&
  isPositiveSafeInteger(limits.maxChunkCount) &&
  isPositiveSafeInteger(limits.maxChunkBytes) &&
  isNonNegativeSafeInteger(limits.maxQueuedDeltaCount) &&
  isNonNegativeSafeInteger(limits.maxQueuedDeltaBytes)

const makeResyncRequest = (
  world: WorldId,
  lastKnownRevision: WorldRevision | undefined,
): AuthoritativeResyncRequest => {
  if (lastKnownRevision === undefined) {
    return { _tag: 'AuthoritativeResyncRequest', world }
  }
  return { _tag: 'AuthoritativeResyncRequest', lastKnownRevision, world }
}

const makeSnapshotTransferFailure = (
  reason: SnapshotTransferFailureReason,
  world?: WorldId,
  lastKnownRevision?: WorldRevision,
): SnapshotTransferFailure => {
  if (world === undefined) {
    return { accepted: false, reason }
  }
  return { accepted: false, reason, request: makeResyncRequest(world, lastKnownRevision) }
}

const validateSnapshotChunk = (
  active: ActiveSnapshotTransfer,
  chunk: ReplicatedWorldSnapshotChunk,
  maxChunkBytes: number,
): SnapshotChunkValidation => {
  if (chunk.transferId !== active.start.transferId) {
    return { accepted: false, reason: 'wrong-transfer-id' }
  }
  if (chunk.index !== active.nextIndex || active.nextIndex >= active.start.chunkCount) {
    return { accepted: false, reason: 'chunk-out-of-order' }
  }
  const fragment = decodeBase64Fragment(chunk.data, maxChunkBytes)
  if (fragment === undefined) {
    return { accepted: false, reason: 'chunk-too-large' }
  }
  if (fragment.length > active.start.totalBytes - active.receivedBytes) {
    return { accepted: false, reason: 'transfer-byte-overflow' }
  }
  return { accepted: true, fragment }
}

const getSnapshotFinishFailure = (
  active: ActiveSnapshotTransfer,
  end: ReplicatedWorldSnapshotEnd,
): SnapshotTransferFailureReason | undefined => {
  if (end.transferId !== active.start.transferId) {
    return 'wrong-transfer-id'
  }
  if (active.nextIndex !== active.start.chunkCount || active.receivedBytes !== active.start.totalBytes) {
    return 'incomplete-transfer'
  }
  if (sha256Hex(active.buffer) !== active.start.sha256) {
    return 'digest-mismatch'
  }
  return undefined
}

/**
 * Bounded receiver for one logical snapshot frame. Limits are supplied by the
 * host from maximum-valid-snapshot and traffic-burst fixtures.
 */
export class SnapshotTransferReceiver {
  readonly #limits: SnapshotTransferLimits
  #active: ActiveSnapshotTransfer | undefined

  static make(limits: SnapshotTransferLimits): Result.Result<SnapshotTransferReceiver, SnapshotTransferConfigError> {
    if (!hasValidTransferLimits(limits)) {
      return Result.fail(
        new SnapshotTransferConfigError({
          detail: 'transfer byte and chunk limits must be positive safe integers; queue limits must be non-negative safe integers',
        }),
      )
    }
    return Result.succeed(new SnapshotTransferReceiver(limits))
  }

  private constructor(limits: SnapshotTransferLimits) {
    this.#limits = { ...limits }
  }

  get isReceiving(): boolean {
    return this.#active !== undefined
  }

  begin(start: ReplicatedWorldSnapshotStart, lastKnownRevision?: WorldRevision): SnapshotTransferReceipt {
    if (this.#active !== undefined) {
      return this.#rejectActive(this.#active, 'transfer-already-active')
    }
    const validDeclaration =
      isPositiveSafeInteger(start.totalBytes) &&
      isPositiveSafeInteger(start.chunkCount) &&
      start.totalBytes <= this.#limits.maxTotalBytes &&
      start.chunkCount <= this.#limits.maxChunkCount &&
      start.chunkCount <= start.totalBytes
    if (!validDeclaration) {
      return makeSnapshotTransferFailure('invalid-declaration', start.world, lastKnownRevision)
    }

    this.#active = {
      buffer: new Uint8Array(start.totalBytes),
      lastKnownRevision,
      nextIndex: ZERO,
      queuedDeltaBytes: ZERO,
      queuedDeltas: [],
      receivedBytes: ZERO,
      start,
    }
    return { accepted: true }
  }

  append(chunk: ReplicatedWorldSnapshotChunk): SnapshotTransferReceipt {
    const active = this.#active
    if (active === undefined) {
      return makeSnapshotTransferFailure('unexpected-transfer-frame')
    }
    const validation = validateSnapshotChunk(active, chunk, this.#limits.maxChunkBytes)
    if (!validation.accepted) {
      return this.#rejectActive(active, validation.reason)
    }
    active.buffer.set(validation.fragment, active.receivedBytes)
    active.receivedBytes += validation.fragment.length
    active.nextIndex += ONE
    return { accepted: true }
  }

  queueDelta(delta: ReplicatedWorldDeltaMessage, frameBytes: number): SnapshotTransferReceipt & Readonly<{ queued?: boolean }> {
    const active = this.#active
    if (active === undefined) {
      return { accepted: true, queued: false }
    }
    const failure = this.#queuedDeltaFailure(active, delta, frameBytes)
    if (failure !== undefined) {
      return this.#rejectActive(active, failure)
    }

    active.queuedDeltas.push({ delta, frameBytes })
    active.queuedDeltaBytes += frameBytes
    return { accepted: true, queued: true }
  }

  finish(end: ReplicatedWorldSnapshotEnd): SnapshotTransferCompletion {
    const active = this.#active
    if (active === undefined) {
      return makeSnapshotTransferFailure('unexpected-transfer-frame')
    }
    const failure = getSnapshotFinishFailure(active, end)
    if (failure !== undefined) {
      return this.#rejectActive(active, failure)
    }

    this.#active = undefined
    return {
      accepted: true,
      completion: {
        frameBytes: active.buffer,
        lastKnownRevision: active.lastKnownRevision,
        maxTotalBytes: this.#limits.maxTotalBytes,
        queuedDeltas: [...active.queuedDeltas],
        revision: active.start.revision,
        world: active.start.world,
      },
    }
  }

  discard(): void {
    this.#active = undefined
  }

  #queuedDeltaFailure(
    active: ActiveSnapshotTransfer,
    delta: ReplicatedWorldDeltaMessage,
    frameBytes: number,
  ): SnapshotTransferFailureReason | undefined {
    if (delta.world !== active.start.world) {
      return 'world-mismatch'
    }
    if (!isPositiveSafeInteger(frameBytes)) {
      return 'delta-queue-overflow'
    }
    if (
      active.queuedDeltas.length >= this.#limits.maxQueuedDeltaCount ||
      frameBytes > this.#limits.maxQueuedDeltaBytes - active.queuedDeltaBytes
    ) {
      return 'delta-queue-overflow'
    }
    return undefined
  }

  #rejectActive(active: ActiveSnapshotTransfer, reason: SnapshotTransferFailureReason): SnapshotTransferFailure {
    this.#active = undefined
    return makeSnapshotTransferFailure(reason, active.start.world, active.lastKnownRevision)
  }
}

export type RevisionAdmission =
  | { readonly accepted: true; readonly revision: number }
  | {
      readonly accepted: false
      readonly reason: 'snapshot-required' | 'duplicate-or-stale' | 'revision-gap'
      readonly expectedRevision?: number
      readonly receivedRevision: number
    }

const checkRevisionAdmission = (current: number | undefined, revision: number): RevisionAdmission => {
  if (current === undefined) {
    return { accepted: false, reason: 'snapshot-required', receivedRevision: revision }
  }
  if (revision <= current) {
    return { accepted: false, reason: 'duplicate-or-stale', receivedRevision: revision }
  }
  const expectedRevision = current + ONE
  if (revision !== expectedRevision) {
    return { accepted: false, expectedRevision, reason: 'revision-gap', receivedRevision: revision }
  }
  return { accepted: true, revision }
}

/**
 * Guards application of authoritative world updates without owning game state.
 *
 * A reconnect clears the baseline, so incremental updates cannot be applied
 * until a complete snapshot establishes which revision the client has.
 */
export class AuthoritativeRevisionTracker {
  readonly #revisions = new Map<WorldId, number>()

  ingestSnapshot(snapshot: WorldSnapshot): RevisionAdmission {
    const current = this.#revisions.get(snapshot.world)
    if (current !== undefined) {
      if (snapshot.revision <= current) {
        return {
          accepted: false,
          reason: 'duplicate-or-stale',
          receivedRevision: snapshot.revision,
        }
      }
    }

    this.#revisions.set(snapshot.world, snapshot.revision)
    return { accepted: true, revision: snapshot.revision }
  }

  ingestRevision(world: WorldId, revision: number): RevisionAdmission {
    const current = this.#revisions.get(world)
    const admission = checkRevisionAdmission(current, revision)
    if (!admission.accepted) {
      return admission
    }
    this.#revisions.set(world, revision)
    return admission
  }

  revision(world: WorldId): number | undefined {
    return this.#revisions.get(world)
  }

  /** Remove one world baseline, or every baseline after transport loss. */
  disconnect(world?: WorldId): void {
    if (arguments.length === ZERO) {
      this.#revisions.clear()
    } else if (world !== undefined) {
      this.#revisions.delete(world)
    }
  }
}

export type AuthoritativeWorldState = Readonly<{
  readonly world: WorldId
  readonly revision: WorldRevision
  readonly owners: ReadonlyMap<ReplicatedOwnerChange['owner'], ReplicatedOwnerChange['state']>
  readonly blocks: ReadonlyMap<string, WorldBlockRead>
}>

export type AuthoritativeClientSnapshot = ReadonlyMap<WorldId, AuthoritativeWorldState>

export type ClientSyncRejectionReason =
  | 'snapshot-required'
  | 'duplicate-or-stale'
  | 'revision-gap'
  | 'duplicate-owner'
  | 'duplicate-block'
  | 'invalid-snapshot'

export type ClientSyncTransition =
  | {
      readonly accepted: true
      readonly appliedMessages: ReadonlyArray<ReplicatedWorldSnapshot | ReplicatedWorldDeltaMessage>
      readonly state: AuthoritativeClientSnapshot
      readonly revision: WorldRevision
    }
  | {
      readonly accepted: false
      readonly state: AuthoritativeClientSnapshot
      readonly reason: ClientSyncRejectionReason
      readonly request: AuthoritativeResyncRequest
    }

const blockAddress = (block: Pick<WorldBlockRead, 'dimension' | 'position'>): string =>
  JSON.stringify([block.dimension, block.position.x, block.position.y, block.position.z])

type ClientRejectionContext = Readonly<{
  readonly world: WorldId
  readonly lastKnownRevision: WorldRevision | undefined
  readonly reason: ClientSyncRejectionReason
}>

const reject = (state: AuthoritativeClientSnapshot, context: ClientRejectionContext): ClientSyncTransition => ({
  accepted: false,
  reason: context.reason,
  request: makeResyncRequest(context.world, context.lastKnownRevision),
  state,
})

const rejectTransfer = (
  state: AuthoritativeClientSnapshot,
  completion: CompletedSnapshotTransfer,
  reason: ClientSyncRejectionReason,
): ClientSyncTransition => {
  const lastKnownRevision = state.get(completion.world)?.revision ?? completion.lastKnownRevision
  return reject(state, { lastKnownRevision, reason, world: completion.world })
}

const addOwnerChange = (
  target: Map<ReplicatedOwnerChange['owner'], ReplicatedOwnerChange['state']>,
  seen: Set<ReplicatedOwnerChange['owner']>,
  change: ReplicatedOwnerChange,
): boolean => {
  if (seen.has(change.owner)) {
    return false
  }
  seen.add(change.owner)
  target.set(change.owner, change.state)
  return true
}

const addOwnerChanges = (
  target: Map<ReplicatedOwnerChange['owner'], ReplicatedOwnerChange['state']>,
  changes: ReadonlyArray<ReplicatedOwnerChange>,
): boolean => {
  const seen = new Set<ReplicatedOwnerChange['owner']>()
  for (const change of changes) {
    if (!addOwnerChange(target, seen, change)) {
      return false
    }
  }
  return true
}

const addBlockReads = (
  target: Map<string, WorldBlockRead>,
  blocks: ReadonlyArray<WorldBlockRead>,
): boolean => {
  const seen = new Set<string>()
  for (const block of blocks) {
    const address = blockAddress(block)
    if (seen.has(address)) {
      return false
    }
    seen.add(address)
    target.set(address, block)
  }
  return true
}

const addBlockChanges = (
  target: Map<string, WorldBlockRead>,
  changes: ReadonlyArray<ReplicatedBlockChange>,
): boolean => {
  const seen = new Set<string>()
  for (const change of changes) {
    const address = blockAddress(change)
    if (seen.has(address)) {
      return false
    }
    seen.add(address)
    target.set(address, {
      dimension: change.dimension,
      position: change.position,
      reading: { _tag: 'Block', block: change.after },
    })
  }
  return true
}

const commitWorld = (
  state: AuthoritativeClientSnapshot,
  worldState: AuthoritativeWorldState,
): AuthoritativeClientSnapshot => {
  const next = new Map(state)
  next.set(worldState.world, worldState)
  return next
}

const buildSnapshotWorld = (snapshot: ReplicatedWorldSnapshot): AuthoritativeWorldState | 'duplicate-owner' | 'duplicate-block' => {
  const owners = new Map<ReplicatedOwnerChange['owner'], ReplicatedOwnerChange['state']>()
  if (!addOwnerChanges(owners, snapshot.owners)) {
    return 'duplicate-owner'
  }
  const blocks = new Map<string, WorldBlockRead>()
  if (!addBlockReads(blocks, snapshot.blocks)) {
    return 'duplicate-block'
  }
  return { blocks, owners, revision: snapshot.revision, world: snapshot.world }
}

const getRevisionRejection = (
  currentRevision: WorldRevision,
  receivedRevision: WorldRevision,
): 'duplicate-or-stale' | 'revision-gap' | undefined => {
  if (receivedRevision <= currentRevision) {
    return 'duplicate-or-stale'
  }
  const nextRevision = currentRevision + ONE
  if (!Number.isSafeInteger(nextRevision) || receivedRevision !== nextRevision) {
    return 'revision-gap'
  }
  return undefined
}

const buildDeltaWorld = (
  current: AuthoritativeWorldState,
  delta: ReplicatedWorldDeltaMessage,
): AuthoritativeWorldState | 'duplicate-owner' | 'duplicate-block' => {
  const owners = new Map(current.owners)
  if (!addOwnerChanges(owners, delta.changes)) {
    return 'duplicate-owner'
  }
  const blocks = new Map(current.blocks)
  if (!addBlockChanges(blocks, delta.blockChanges)) {
    return 'duplicate-block'
  }
  return { blocks, owners, revision: delta.revision, world: delta.world }
}

/** Build a complete replacement before exposing it to the caller. */
export const applyReplicatedWorldSnapshot = (
  state: AuthoritativeClientSnapshot,
  snapshot: ReplicatedWorldSnapshot,
): ClientSyncTransition => {
  const current = state.get(snapshot.world)
  if (current !== undefined && snapshot.revision < current.revision) {
    return reject(state, { lastKnownRevision: current.revision, reason: 'duplicate-or-stale', world: snapshot.world })
  }

  const nextWorld = buildSnapshotWorld(snapshot)
  if (typeof nextWorld === 'string') {
    return reject(state, { lastKnownRevision: current?.revision, reason: nextWorld, world: snapshot.world })
  }

  return {
    accepted: true,
    appliedMessages: [snapshot],
    revision: snapshot.revision,
    state: commitWorld(state, nextWorld),
  }
}

/** Validate both arrays and the revision before publishing one replacement state. */
export const applyReplicatedWorldDelta = (
  state: AuthoritativeClientSnapshot,
  delta: ReplicatedWorldDeltaMessage,
): ClientSyncTransition => {
  const current = state.get(delta.world)
  if (current === undefined) {
    return reject(state, { lastKnownRevision: undefined, reason: 'snapshot-required', world: delta.world })
  }
  const revisionRejection = getRevisionRejection(current.revision, delta.revision)
  if (revisionRejection !== undefined) {
    return reject(state, { lastKnownRevision: current.revision, reason: revisionRejection, world: delta.world })
  }
  const nextWorld = buildDeltaWorld(current, delta)
  if (typeof nextWorld === 'string') {
    return reject(state, { lastKnownRevision: current.revision, reason: nextWorld, world: delta.world })
  }
  return {
    accepted: true,
    appliedMessages: [delta],
    revision: delta.revision,
    state: commitWorld(state, nextWorld),
  }
}

const transferredSnapshotMatches = (
  message: NetworkMessageType,
  completion: CompletedSnapshotTransfer,
): message is ReplicatedWorldSnapshot =>
  message._tag === 'ReplicatedWorldSnapshot' &&
  message.world === completion.world &&
  message.revision === completion.revision

const decodeTransferredSnapshotFrameForCompletion = (
  frameText: string,
  completion: CompletedSnapshotTransfer,
  owners: ReplicatedOwnerRegistry,
): Result.Result<ReplicatedWorldSnapshot, ProtocolError> => Result.flatMap(
  decodeTransferredSnapshotFrame(frameText, owners, completion.maxTotalBytes),
  (message) => {
    if (!transferredSnapshotMatches(message, completion)) {
      return Result.fail(
        new ProtocolError({ detail: 'snapshot transfer metadata does not match its frame', reason: 'malformed-frame' }),
      )
    }
    return Result.succeed(message)
  },
)

export const decodeTransferredSnapshot = (
  completion: CompletedSnapshotTransfer,
  owners: ReplicatedOwnerRegistry,
): Result.Result<ReplicatedWorldSnapshot, ProtocolError> => {
  if (!isPositiveSafeInteger(completion.maxTotalBytes) || completion.frameBytes.length > completion.maxTotalBytes) {
    return Result.fail(new ProtocolError({ detail: 'snapshot transfer exceeds its configured byte limit', reason: 'frame-too-large' }))
  }
  const frameText = decodeUtf8Frame(completion.frameBytes)
  if (frameText === undefined) {
    return Result.fail(
      new ProtocolError({ detail: 'snapshot transfer contains invalid UTF-8', reason: 'malformed-frame' }),
    )
  }
  return decodeTransferredSnapshotFrameForCompletion(frameText, completion, owners)
}

type QueuedTransferDeltaInput = Readonly<{
  readonly previousState: AuthoritativeClientSnapshot
  readonly completion: CompletedSnapshotTransfer
  readonly candidateState: AuthoritativeClientSnapshot
  readonly queued: QueuedReplicatedDelta
}>

const applyQueuedTransferDelta = (input: QueuedTransferDeltaInput): ClientSyncTransition => {
  const { previousState, completion, candidateState, queued } = input
  if (queued.delta.world !== completion.world) {
    return rejectTransfer(previousState, completion, 'invalid-snapshot')
  }
  const applied = applyReplicatedWorldDelta(candidateState, queued.delta)
  if (!applied.accepted) {
    return rejectTransfer(previousState, completion, applied.reason)
  }
  return applied
}

type QueuedTransferInput = Readonly<{
  readonly previousState: AuthoritativeClientSnapshot
  readonly completion: CompletedSnapshotTransfer
  readonly snapshot: ReplicatedWorldSnapshot
  readonly initialState: Extract<ClientSyncTransition, { readonly accepted: true }>
}>

const applyQueuedTransferDeltas = (input: QueuedTransferInput): ClientSyncTransition => {
  let candidateState = input.initialState.state
  let latestRevision = input.initialState.revision
  const appliedMessages: Array<ReplicatedWorldSnapshot | ReplicatedWorldDeltaMessage> = [
    input.snapshot,
    ...input.completion.queuedDeltas.map(({ delta }) => delta),
  ]
  for (const queued of input.completion.queuedDeltas) {
    const applied = applyQueuedTransferDelta({
      candidateState,
      completion: input.completion,
      previousState: input.previousState,
      queued,
    })
    if (!applied.accepted) {
      return applied
    }
    candidateState = applied.state
    latestRevision = applied.revision
  }
  return { accepted: true, appliedMessages, revision: latestRevision, state: candidateState }
}

const applyDecodedSnapshotTransfer = (
  previousState: AuthoritativeClientSnapshot,
  completion: CompletedSnapshotTransfer,
  snapshot: ReplicatedWorldSnapshot,
): ClientSyncTransition => {
  const initialState = applyReplicatedWorldSnapshot(previousState, snapshot)
  if (!initialState.accepted) {
    return initialState
  }
  return applyQueuedTransferDeltas({ completion, initialState, previousState, snapshot })
}

/** A synchronous client cache swaps one immutable world projection per accepted group. */
export class AuthoritativeClientState {
  #state: AuthoritativeClientSnapshot = new Map()

  get snapshot(): AuthoritativeClientSnapshot {
    return this.#state
  }

  world(world: WorldId): AuthoritativeWorldState | undefined {
    return this.#state.get(world)
  }

  applySnapshot(snapshot: ReplicatedWorldSnapshot): ClientSyncTransition {
    const result = applyReplicatedWorldSnapshot(this.#state, snapshot)
    if (result.accepted) {
      this.#state = result.state
    }
    return result
  }

  applyDelta(delta: ReplicatedWorldDeltaMessage): ClientSyncTransition {
    const result = applyReplicatedWorldDelta(this.#state, delta)
    if (result.accepted) {
      this.#state = result.state
    }
    return result
  }

  applyTransfer(completion: CompletedSnapshotTransfer, owners: ReplicatedOwnerRegistry): ClientSyncTransition {
    const previousState = this.#state
    const decoded = decodeTransferredSnapshot(completion, owners)
    const result = Result.match(decoded, {
      onFailure: () => rejectTransfer(previousState, completion, 'invalid-snapshot'),
      onSuccess: (snapshot) => applyDecodedSnapshotTransfer(previousState, completion, snapshot),
    })
    if (result.accepted) {
      this.#state = result.state
    }
    return result
  }

  disconnect(world?: WorldId): void {
    if (world === undefined) {
      this.#state = new Map()
      return
    }
    if (this.#state.has(world)) {
      const next = new Map(this.#state)
      next.delete(world)
      this.#state = next
    }
  }
}
