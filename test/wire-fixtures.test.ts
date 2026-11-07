import { describe, expect, it } from '@effect/vitest'
import { readFileSync } from 'node:fs'
import { Effect, Result, Schema } from 'effect'
import { decodeFrame, encodeFrame } from '../src/domain/codec'
import { NetworkMessage, PROTOCOL_VERSION } from '../src/domain/protocol'

const item = { count: 2, durability: { current: 63, max: 64 }, item: 'stone' }
const commandHeader = { commandId: 'command-1', expectedRevision: 12, player: 'alice', world: 'overworld' }
const playerMove = Schema.decodeUnknownSync(NetworkMessage)({
  _tag: 'PlayerMove',
  at: { x: -0.5, y: 64.125, z: 1024 },
  facing: { pitchRadians: -1.5, yawRadians: 3.14159 },
  player: 'alice',
})
const samples = [
  { family: 'world-sync', slug: 'player-move', message: playerMove },
  {
    family: 'player-state',
    slug: 'player-inventory-delta',
    message: Schema.decodeUnknownSync(NetworkMessage)({
      _tag: 'PlayerInventoryDelta',
      player: 'alice',
      revision: 13,
      state: { selectedSlot: 0, slots: [item] },
      world: 'overworld',
    }),
  },
  {
    family: 'containers',
    slug: 'container-delta',
    message: Schema.decodeUnknownSync(NetworkMessage)({
      _tag: 'ContainerDelta',
      revision: 13,
      state: { containerId: 'dropper:1', kind: 'dropper', slots: [item] },
      world: 'overworld',
    }),
  },
  {
    family: 'workbenches',
    slug: 'anvil-command',
    message: Schema.decodeUnknownSync(NetworkMessage)({
      _tag: 'AnvilCommand',
      ...commandHeader,
      name: 'Excalibur',
      slot: 0,
    }),
  },
  {
    family: 'entities',
    slug: 'entity-despawn-delta',
    message: Schema.decodeUnknownSync(NetworkMessage)({
      _tag: 'EntityDespawnDelta',
      entityId: 'entity-1',
      revision: 13,
      world: 'overworld',
    }),
  },
  {
    family: 'dimensions-bosses',
    slug: 'toggle-lever-command',
    message: Schema.decodeUnknownSync(NetworkMessage)({
      _tag: 'ToggleLeverCommand',
      ...commandHeader,
      lever: { x: 1, y: 64, z: 2 },
    }),
  },
]

const currentSource = {
  directory: 'v0.14.0',
  sourceVersion: '0.14.0',
  sourceTag: 'v0.14.0',
  sourceCommit: 'f01d7083c833d171190eb3579882c0feec970fee',
  protocolVersion: PROTOCOL_VERSION,
  generatingCommand: 'nix develop --command pnpm exec tsx /tmp/x2-old/current/generate-wire-frames.mjs',
}
const legacySources = [
  {
    directory: 'v0.11.0',
    sourceVersion: '0.11.0',
    sourceTag: 'v0.11.0',
    sourceCommit: '041098142dece173649b091d29d3fa94991fffe8',
    protocolVersion: 8,
    tarballShasum: '52871b87f3abae2d553cc607755c3c26ab731f4f',
    generatingCommand: 'nix develop <project-flake> --command node generate-wire-frames.mjs',
    generatingWorkingDirectory: '/tmp/x2-old/0.11.0/codec-runtime',
  },
  {
    directory: 'v0.12.0',
    sourceVersion: '0.12.0',
    sourceTag: 'v0.12.0',
    sourceCommit: '2375e1991dceb1184f9d5dbf4ee4c72c14395082',
    protocolVersion: 8,
    tarballShasum: 'fef8ee7900f3804210877954e3c4ebc3d50d8ea6',
    generatingCommand: 'nix develop <project-flake> --command node generate-wire-frames.mjs',
    generatingWorkingDirectory: '/tmp/x2-old/0.12.0/codec-runtime',
  },
]

const readFrame = (directory: string, slug: string): Buffer =>
  readFileSync(new URL(`./fixtures/wire/${directory}/${slug}.frame`, import.meta.url))

const readManifest = (directory: string, slug: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/wire/${directory}/${slug}.manifest.json`, import.meta.url), 'utf8'))

const expectedManifest = (
  source: typeof currentSource | (typeof legacySources)[number],
  family: string,
  messageTag: string,
) => ({
  family,
  messageTag,
  protocolVersion: source.protocolVersion,
  sourceVersion: source.sourceVersion,
  sourceTag: source.sourceTag,
  ...('sourceCommit' in source ? { sourceCommit: source.sourceCommit } : {}),
  ...('tarballShasum' in source ? { tarballShasum: source.tarballShasum } : {}),
  generatingCommand: source.generatingCommand,
  ...('generatingWorkingDirectory' in source ? { generatingWorkingDirectory: source.generatingWorkingDirectory } : {}),
})

describe('released wire fixtures', () => {
  // REGRESSION: version-8 frames must be explicitly rejected before their payloads are parsed as version 10.
  it.effect('pins current golden bytes and version rejection for every representative family', () =>
    Effect.sync(() => {
      for (const sample of samples) {
        const currentBytes = readFrame(currentSource.directory, sample.slug)
        const currentText = currentBytes.toString('utf8')
        expect(readManifest(currentSource.directory, sample.slug)).toStrictEqual(
          expectedManifest(currentSource, sample.family, sample.message._tag),
        )

        const encoded = encodeFrame(sample.message)
        if (Result.isFailure(encoded)) {
          throw new Error(`${sample.message._tag} current sample cannot encode: ${encoded.failure.reason}`)
        }
        expect(Buffer.from(encoded.success, 'utf8')).toEqual(currentBytes)

        const currentDecoded = decodeFrame(currentText)
        if (Result.isFailure(currentDecoded)) {
          throw new Error(`${sample.message._tag} current golden cannot decode: ${currentDecoded.failure.reason}`)
        }
        expect(currentDecoded.success).toStrictEqual(sample.message)

        for (const source of legacySources) {
          const legacyBytes = readFrame(source.directory, sample.slug)
          expect(readManifest(source.directory, sample.slug)).toStrictEqual(
            expectedManifest(source, sample.family, sample.message._tag),
          )
          const legacyDecoded = decodeFrame(legacyBytes.toString('utf8'))
          if (Result.isSuccess(legacyDecoded)) {
            expect(legacyDecoded.success).toStrictEqual(sample.message)
            throw new Error(`${source.sourceTag} ${sample.message._tag} unexpectedly accepted an old frame`)
          }
          expect(legacyDecoded.failure.reason).toBe('unsupported-protocol-version')
        }
      }
    }),
  )

  // REGRESSION: changing one protocol-version byte must flip an accepted golden into a typed rejection.
  it.effect('changes the verdict after a one-byte mutation of a current fixture', () =>
    Effect.sync(() => {
      const originalBytes = readFrame(currentSource.directory, 'player-move')
      const versionMarker = Buffer.from(`"protocolVersion":${PROTOCOL_VERSION}`)
      const versionMarkerOffset = originalBytes.indexOf(versionMarker)
      if (versionMarkerOffset < 0) {
        throw new Error('current fixture has no protocolVersion marker')
      }
      const versionByteOffset = versionMarkerOffset + versionMarker.length - 1
      const originalVersionByte = originalBytes.at(versionByteOffset)
      if (originalVersionByte === undefined) {
        throw new Error('current fixture protocolVersion byte is missing')
      }

      const mutatedBytes = Buffer.from(originalBytes)
      mutatedBytes.set([originalVersionByte === 0x30 ? 0x31 : 0x30], versionByteOffset)
      let changedByteCount = 0
      for (let index = 0; index < originalBytes.length; index += 1) {
        if (originalBytes.at(index) !== mutatedBytes.at(index)) {
          changedByteCount += 1
        }
      }
      expect(changedByteCount).toBe(1)

      const originalVerdict = decodeFrame(originalBytes.toString('utf8'))
      if (Result.isFailure(originalVerdict)) {
        throw new Error(`current fixture unexpectedly rejected: ${originalVerdict.failure.reason}`)
      }
      expect(originalVerdict.success).toStrictEqual(playerMove)

      const mutatedVerdict = decodeFrame(mutatedBytes.toString('utf8'))
      if (Result.isSuccess(mutatedVerdict)) {
        expect(mutatedVerdict.success).toStrictEqual(playerMove)
        throw new Error('one-byte protocolVersion mutation was unexpectedly accepted')
      }
      expect(mutatedVerdict.failure.reason).toBe('unsupported-protocol-version')
    }),
  )
})
