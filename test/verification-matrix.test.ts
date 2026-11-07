import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MESSAGE_TAGS } from '../src/domain/protocol.js'
import { MATRIX_ANGLES, matrixGroups, type MatrixCell, type MatrixAngle } from './matrix/index.js'

const sourceTags = [...MESSAGE_TAGS]
const groupedRows = matrixGroups.flatMap((group) =>
  Object.entries(group.rows).map(([tag, row]) => ({ group: group.name, tag, row })),
)
const rowsByTag = new Map(groupedRows.map(({ tag, row }) => [tag, row]))

const assertGapCell = (tag: string, angle: MatrixAngle, cell: unknown): void => {
  if (cell === null || typeof cell !== 'object' || !('status' in cell) || cell.status !== 'gap') {
    throw new Error(`${tag} ${angle} is not a gap cell`)
  }
  if (!('reason' in cell) || typeof cell.reason !== 'string' || cell.reason.trim().length === 0) {
    throw new Error(`${tag} ${angle} (gap) has no reason`)
  }
  if (!('evidence' in cell) || !Array.isArray(cell.evidence) || cell.evidence.length === 0 ||
      cell.evidence.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error(`${tag} ${angle} (gap) has no evidence`)
  }
}

const commandApplicationSource = readFileSync(
  resolve(process.cwd(), 'src/application/server/command-application.ts'),
  'utf8',
)

const testReferences = (file: string, line: number, testName: string): void => {
  if (!file.startsWith('test/') || file.split('/').includes('..')) {
    throw new Error(`covered reference must stay under test/: ${file}:${line}`)
  }
  if (!Number.isInteger(line) || line < 1 || testName.trim().length === 0) {
    throw new Error(`invalid covered reference ${file}:${line} (${testName})`)
  }

  const path = resolve(process.cwd(), file)
  const contents = (() => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      throw new Error(`covered reference does not exist: ${file}:${line} (${testName})`)
    }
  })()

  const sourceLine = contents.split(/\r?\n/)[line - 1]
  if (sourceLine === undefined || !sourceLine.includes(testName) || !/\b(?:it|test)(?:\.[\w$]+)*\s*\(/.test(sourceLine)) {
    throw new Error(`covered reference is not the named test declaration: ${file}:${line} (${testName})`)
  }
}

const unsupportedReasonsFromSource = (source: string): Record<string, string> => {
  const declaration = source.indexOf('const UNSUPPORTED_COMMAND_REASONS:')
  if (declaration < 0) {
    throw new Error('UNSUPPORTED_COMMAND_REASONS declaration is missing')
  }
  const equals = source.indexOf('=', declaration)
  const openingBrace = source.indexOf('{', equals)
  const closingBrace = source.indexOf('\n}', openingBrace)
  if (equals < 0 || openingBrace < 0 || closingBrace < 0) {
    throw new Error('UNSUPPORTED_COMMAND_REASONS is not a closed object literal')
  }

  const entries: Array<readonly [string, string]> = []
  for (const line of source.slice(openingBrace + 1, closingBrace).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }
    const entry = trimmed.match(/^(?<tag>[A-Za-z][A-Za-z0-9]*):\s*'(?<reason>[^']+)',?$/)
    if (entry === null) {
      throw new Error(`cannot parse UNSUPPORTED_COMMAND_REASONS entry: ${trimmed}`)
    }
    const tag = entry.groups?.['tag']
    const reason = entry.groups?.['reason']
    if (tag === undefined || reason === undefined) {
      throw new Error(`cannot read UNSUPPORTED_COMMAND_REASONS entry: ${trimmed}`)
    }
    entries.push([tag, reason])
  }

  const result = Object.fromEntries(entries)
  if (Object.keys(result).length !== entries.length) {
    throw new Error('UNSUPPORTED_COMMAND_REASONS has duplicate tags')
  }
  return result
}

describe('verification matrix', () => {
  it('rejects a gap without a reason or evidence', () => {
    expect(() => assertGapCell('negative-control', 'A1', {
      status: 'gap',
      evidence: ['src/domain/protocol.ts:1102-1147'],
    })).toThrow('negative-control A1 (gap) has no reason')
    expect(() => assertGapCell('negative-control', 'A1', {
      status: 'gap',
      reason: 'The mx runtime has no path for this command.',
      evidence: [],
    })).toThrow('negative-control A1 (gap) has no evidence')
  })

  it('matches MESSAGE_TAGS exactly with no duplicate rows', () => {
    const occurrences = new Map<string, string[]>()
    for (const { group, tag } of groupedRows) {
      const groups = occurrences.get(tag) ?? []
      groups.push(group)
      occurrences.set(tag, groups)
    }

    const duplicateTags = [...occurrences]
      .filter(([, groups]) => groups.length > 1)
      .map(([tag]) => tag)
      .sort()
    expect(duplicateTags, `duplicate tags: ${duplicateTags.join(', ')}`).toEqual([])

    const groupedTags = [...occurrences.keys()].sort()
    const expectedTags = [...sourceTags].sort()
    const missingTags = expectedTags.filter((tag) => !occurrences.has(tag))
    const sourceTagSet = new Set<string>(sourceTags)
    const extraTags = groupedTags.filter((tag) => !sourceTagSet.has(tag))
    expect(missingTags, `tags without rows: ${missingTags.join(', ')}`).toEqual([])
    expect(extraTags, `rows not in MESSAGE_TAGS: ${extraTags.join(', ')}`).toEqual([])
  })

  it('fills every tag and angle with a valid state', () => {
    const statuses = new Set<MatrixCell['status']>([
      'covered',
      'pending',
      'excluded',
      'blocked-on-mc-sim',
      'gap',
    ])
    const statusCounts: Record<MatrixCell['status'], number> = {
      covered: 0,
      pending: 0,
      excluded: 0,
      'blocked-on-mc-sim': 0,
      gap: 0,
    }
    const gapLocations: string[] = []

    for (const tag of sourceTags) {
      const row = rowsByTag.get(tag)
      if (row === undefined || row === null || typeof row !== 'object') {
        throw new Error(`${tag} has no matrix row`)
      }

      for (const angle of MATRIX_ANGLES) {
        const cell = row[angle]
        if (cell === undefined || cell === null || typeof cell !== 'object') {
          throw new Error(`${tag} ${angle} is empty`)
        }

        const status = cell.status
        if (typeof status !== 'string' || !statuses.has(status)) {
          throw new Error(`${tag} ${angle} has an invalid status: ${String(status)}`)
        }
        statusCounts[status] += 1
        const reason = cell.status === 'excluded' || cell.status === 'blocked-on-mc-sim'
          ? cell.reason
          : undefined
        if ((status === 'excluded' || status === 'blocked-on-mc-sim') &&
            (typeof reason !== 'string' || reason.trim().length === 0)) {
          throw new Error(`${tag} ${angle} (${status}) has no reason`)
        }
        if (status === 'gap') {
          assertGapCell(tag, angle, cell)
          gapLocations.push(`${tag} ${angle}`)
        }

        if (Object.hasOwn(cell, 'unsupportedCommandReason') && angle !== 'A2') {
          throw new Error(`${tag} ${angle} records an unsupported command outside A2`)
        }
        if (status === 'covered') {
          if (!Array.isArray(cell.tests) || cell.tests.length === 0) {
            throw new Error(`${tag} ${angle} is covered without a test reference`)
          }
          for (const reference of cell.tests) {
            if (reference === null || typeof reference !== 'object') {
              throw new Error(`${tag} ${angle} has an invalid test reference`)
            }
            if (typeof reference.file !== 'string' || typeof reference.line !== 'number' ||
                typeof reference.testName !== 'string') {
              throw new Error(`${tag} ${angle} has an incomplete test reference`)
            }
            testReferences(reference.file, reference.line, reference.testName)
          }
        }
      }
    }

    console.info(
      `Matrix cell counts: ${Object.entries(statusCounts).map(([status, count]) => `${status}=${count}`).join(', ')}\n` +
      `Gaps (${gapLocations.length}): ${gapLocations.length > 0 ? gapLocations.join(', ') : 'none'}`,
    )
  })

  it('matches recorded unsupported commands to command application', () => {
    const recorded: Record<string, string> = {}
    for (const { tag, row } of groupedRows) {
      const a2 = row?.A2
      if (a2?.status === 'covered' && a2.unsupportedCommandReason !== undefined) {
        recorded[tag] = a2.unsupportedCommandReason
      }
    }

    const current = unsupportedReasonsFromSource(commandApplicationSource)
    expect(recorded).toStrictEqual(current)
  })
})
