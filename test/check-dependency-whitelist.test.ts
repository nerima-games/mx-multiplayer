import { readFileSync } from 'node:fs'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  allowedDirectDependencies,
  checkDeclaredDependencies,
  checkPolicyConfiguration,
  classifyImport,
  extractOrgPackageName,
  findBannedTimeSources,
  findCycles,
  findTransitivePath,
  isToolingOrTestPath,
  maskSource,
  parseImports,
  REPOSITORY_POLICY,
  SCAN_ROOTS,
  type DeclaredDependencies,
} from '../scripts/check-dependency-whitelist'

const NOTHING_DECLARED: DeclaredDependencies = {
  dependencies: new Set<string>(),
  devDependencies: new Set<string>(),
}

const graph = (entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>): Map<string, ReadonlySet<string>> =>
  new Map(entries.map(([node, targets]) => [node, new Set(targets)]))

describe('mx-multiplayer dependency policy', () => {
  it.effect('depends on mc-sim and on nothing else — transport talks to state, not to rules', () =>
    Effect.sync(() => {
      expect(REPOSITORY_POLICY.thisPackage).toBe('@nerima-games/mx-multiplayer')
      expect([...allowedDirectDependencies()].sort()).toStrictEqual(['@nerima-games/mc-sim'])
    }),
  )

  it.effect('has an internally consistent configuration, so the gate itself cannot be quietly broken', () =>
    Effect.sync(() => {
      expect(checkPolicyConfiguration()).toStrictEqual([])
    }),
  )

  // REGRESSION: "the roster is complete". The graph is a mirror of 16
  // repositories; a missing row makes every import of the absent package fail
  // as `unknown-package`, and — worse — makes a cycle through it invisible.
  it.effect('carries all 16 repositories of the roster, not just this one', () =>
    Effect.sync(() => {
      expect([...REPOSITORY_POLICY.dependencyGraph.keys()].sort()).toStrictEqual([
        '@nerima-games/mc-audio',
        '@nerima-games/mc-compose',
        '@nerima-games/mc-dev-meta',
        '@nerima-games/mc-kernel',
        '@nerima-games/mc-meshing',
        '@nerima-games/mc-noise',
        '@nerima-games/mc-physics',
        '@nerima-games/mc-playground-kit',
        '@nerima-games/mc-render',
        '@nerima-games/mc-save',
        '@nerima-games/mc-sim',
        '@nerima-games/mc-worldgen',
        '@nerima-games/mx-gameplay',
        '@nerima-games/mx-multiplayer',
        '@nerima-games/mx-redstone',
        '@nerima-games/mx-ui',
      ])
    }),
  )

  // REGRESSION: plan.md §2.3-1 — the four experience modules have zero edges
  // between them. "mining puts an item in the inventory" goes through mc-sim's
  // InventoryService, not through an mx-gameplay -> mx-ui import.
  it.effect('records no edge between any two experience modules', () =>
    Effect.sync(() => {
      const experience = [
        '@nerima-games/mx-gameplay',
        '@nerima-games/mx-redstone',
        '@nerima-games/mx-ui',
        '@nerima-games/mx-multiplayer',
      ]
      for (const module of experience) {
        for (const target of REPOSITORY_POLICY.dependencyGraph.get(module) ?? []) {
          expect(experience).not.toContain(target)
        }
      }
    }),
  )

  // REGRESSION: mc-kernel is universally importable, which is expressed by its
  // ABSENCE from every row. `checkPolicyConfiguration` rejects a graph that
  // names it; this pins the intent so the rule is not "fixed" by adding it.
  it.effect('never names mc-kernel as an edge, because it is importable everywhere', () =>
    Effect.sync(() => {
      for (const targets of REPOSITORY_POLICY.dependencyGraph.values()) {
        expect([...targets]).not.toContain('@nerima-games/mc-kernel')
      }
    }),
  )

  // REGRESSION: plan.md §3.10 / §2.3-2 — mc-playground-kit is devDependency
  // only. A runtime edge to it would delete input handling from the shipped
  // build, so it must appear in no row's value set at all.
  it.effect('never names mc-playground-kit as a runtime edge', () =>
    Effect.sync(() => {
      for (const targets of REPOSITORY_POLICY.dependencyGraph.values()) {
        expect([...targets]).not.toContain('@nerima-games/mc-playground-kit')
      }
    }),
  )

  it.effect('declares a graph with no cycles anywhere in the roster', () =>
    Effect.sync(() => {
      expect(findCycles(REPOSITORY_POLICY.dependencyGraph)).toStrictEqual([])
    }),
  )
})

describe('the reach this repository does not have', () => {
  const from = (importedPackage: string) => ({
    importedPackage,
    filePath: 'domain/transport.ts',
    line: 1,
    isToolingOrTest: false,
  })

  const declaredEverything: DeclaredDependencies = {
    dependencies: new Set([
      '@nerima-games/mc-sim',
      '@nerima-games/mc-physics',
      '@nerima-games/mc-worldgen',
      '@nerima-games/mx-ui',
    ]),
    devDependencies: new Set<string>(),
  }

  // REGRESSION: "a transitive dependency is not an import licence".
  // mc-sim depends on mc-physics, so node_modules will physically contain it.
  // Importing it anyway is how a 16-repository split turns back into a
  // monolith, and it is invisible to `tsc`.
  it.effect('rejects reaching through mc-sim to mc-physics, and names the path', () =>
    Effect.sync(() => {
      const violation = classifyImport(from('@nerima-games/mc-physics'), declaredEverything)
      expect(violation?.rule).toBe('transitive-import')
      expect(violation?.message).toContain('@nerima-games/mc-sim -> @nerima-games/mc-physics')
    }),
  )

  it.effect('rejects reaching through mc-sim to mc-worldgen and mc-save alike', () =>
    Effect.sync(() => {
      expect(classifyImport(from('@nerima-games/mc-worldgen'), declaredEverything)?.rule).toBe(
        'transitive-import',
      )
      expect(classifyImport(from('@nerima-games/mc-save'), declaredEverything)?.rule).toBe(
        'transitive-import',
      )
    }),
  )

  // REGRESSION: plan.md §3.14 — "the reference implementation's main-menu flow
  // and multiplayer screens belong to mx-ui". mx-ui is not reachable at all, so
  // importing it is a flat whitelist violation rather than a transitive one.
  it.effect('rejects importing mx-ui outright: the multiplayer screens are not this repository', () =>
    Effect.sync(() => {
      const violation = classifyImport(from('@nerima-games/mx-ui'), declaredEverything)
      expect(violation?.rule).toBe('not-whitelisted')
      expect(violation?.message).toContain('@nerima-games/mc-sim')
    }),
  )

  it.effect('allows mc-sim itself when it is declared', () =>
    Effect.sync(() => {
      expect(classifyImport(from('@nerima-games/mc-sim'), declaredEverything)).toBeUndefined()
    }),
  )

  it.effect('allows mc-kernel without it appearing in any allowlist, once declared', () =>
    Effect.sync(() => {
      expect(
        classifyImport(from('@nerima-games/mc-kernel'), {
          dependencies: new Set(['@nerima-games/mc-kernel']),
          devDependencies: new Set<string>(),
        }),
      ).toBeUndefined()
    }),
  )
})

describe('cycle rejection', () => {
  it.effect('rejects a two-node cycle outright — there is no co-evolution allowlist in this project', () =>
    Effect.sync(() => {
      const violations = findCycles(graph([['a', ['b']], ['b', ['a']]]))
      expect(violations.length).toBeGreaterThan(0)
      expect(violations[0]?.rule).toBe('cycle')
      expect(violations[0]?.message).toContain('->')
    }),
  )

  it.effect('rejects a longer cycle and names the path it found', () =>
    Effect.sync(() => {
      const violations = findCycles(graph([['a', ['b']], ['b', ['c']], ['c', ['a']]]))
      expect(violations.length).toBeGreaterThan(0)
      expect(violations[0]?.message).toContain('a -> b -> c -> a')
    }),
  )

  it.effect('accepts a diamond, because a DAG with a shared descendant is not a cycle', () =>
    Effect.sync(() => {
      const violations = findCycles(
        graph([['a', ['b', 'c']], ['b', ['d']], ['c', ['d']], ['d', []]]),
      )
      expect(violations).toStrictEqual([])
    }),
  )

  it.effect('accepts an empty graph and the single-node kernel graph', () =>
    Effect.sync(() => {
      expect(findCycles(graph([]))).toStrictEqual([])
      expect(findCycles(graph([['@nerima-games/mc-kernel', []]]))).toStrictEqual([])
    }),
  )
})

describe('transitive closure', () => {
  it.effect('findTransitivePath produces the chain that explains why an import is not licensed', () =>
    Effect.sync(() => {
      const declared = graph([
        ['@nerima-games/mc-app', ['@nerima-games/mc-sim']],
        ['@nerima-games/mc-sim', ['@nerima-games/mc-physics']],
        ['@nerima-games/mc-physics', []],
      ])

      expect(findTransitivePath(declared, '@nerima-games/mc-app', '@nerima-games/mc-physics')).toStrictEqual([
        '@nerima-games/mc-app',
        '@nerima-games/mc-sim',
        '@nerima-games/mc-physics',
      ])
    }),
  )

  it.effect('findTransitivePath returns undefined when there is no path at all', () =>
    Effect.sync(() => {
      const declared = graph([['a', ['b']], ['b', []], ['c', []]])
      expect(findTransitivePath(declared, 'a', 'c')).toBeUndefined()
    }),
  )
})

describe('classifyImport', () => {
  const site = (importedPackage: string, isToolingOrTest = false) => ({
    importedPackage,
    filePath: isToolingOrTest ? 'test/example.test.ts' : 'domain/example.ts',
    line: 3,
    isToolingOrTest,
  })

  it.effect('rejects importing this package by name instead of relatively', () =>
    Effect.sync(() => {
      const violation = classifyImport(site('@nerima-games/mx-multiplayer'), NOTHING_DECLARED)
      expect(violation?.rule).toBe('self-import')
    }),
  )

  it.effect('rejects an org package that is not in the declared graph, so the gate fails closed', () =>
    Effect.sync(() => {
      const violation = classifyImport(site('@nerima-games/mc-does-not-exist'), NOTHING_DECLARED)
      expect(violation?.rule).toBe('unknown-package')
      expect(violation?.filePath).toBe('domain/example.ts')
      expect(violation?.line).toBe(3)
    }),
  )

  it.effect('rejects mc-playground-kit imported from shipped source, with the reason spelled out', () =>
    Effect.sync(() => {
      const violation = classifyImport(site('@nerima-games/mc-playground-kit'), {
        dependencies: new Set<string>(),
        devDependencies: new Set(['@nerima-games/mc-playground-kit']),
      })
      expect(violation?.rule).toBe('dev-only-package-in-shipped-source')
      expect(violation?.message).toContain('input handling')
    }),
  )

  it.effect('allows mc-playground-kit from a test file when it is declared in devDependencies', () =>
    Effect.sync(() => {
      const violation = classifyImport(site('@nerima-games/mc-playground-kit', true), {
        dependencies: new Set<string>(),
        devDependencies: new Set(['@nerima-games/mc-playground-kit']),
      })
      expect(violation).toBeUndefined()
    }),
  )

  it.effect('still requires an otherwise-allowed import to be declared in package.json', () =>
    Effect.sync(() => {
      const violation = classifyImport(site('@nerima-games/mc-playground-kit', true), NOTHING_DECLARED)
      expect(violation?.rule).toBe('undeclared-dependency')
    }),
  )
})

describe('checkDeclaredDependencies', () => {
  it.effect('rejects @nerima-games/mc-playground-kit in "dependencies", because it is devDependency-only', () =>
    Effect.sync(() => {
      const violations = checkDeclaredDependencies({
        dependencies: new Set(['effect', '@nerima-games/mc-playground-kit']),
        devDependencies: new Set<string>(),
      })
      expect(violations).toHaveLength(1)
      expect(violations[0]?.rule).toBe('dev-only-package-in-dependencies')
      expect(violations[0]?.message).toContain('input handling')
    }),
  )

  it.effect('accepts @nerima-games/mc-playground-kit in "devDependencies"', () =>
    Effect.sync(() => {
      const violations = checkDeclaredDependencies({
        dependencies: new Set(['effect']),
        devDependencies: new Set(['@nerima-games/mc-playground-kit', 'vitest']),
      })
      expect(violations).toStrictEqual([])
    }),
  )

  it.effect('rejects an org dependency the policy does not allow, even if the code never imports it', () =>
    Effect.sync(() => {
      const violations = checkDeclaredDependencies({
        dependencies: new Set(['@nerima-games/mc-render']),
        devDependencies: new Set<string>(),
      })
      expect(violations).toHaveLength(1)
      expect(violations[0]?.rule).toBe('undeclared-in-policy')
    }),
  )

  it.effect('ignores non-org dependencies entirely', () =>
    Effect.sync(() => {
      const violations = checkDeclaredDependencies({
        dependencies: new Set(['effect', 'three']),
        devDependencies: new Set(['vitest', 'oxlint']),
      })
      expect(violations).toStrictEqual([])
    }),
  )
})

describe('maskSource', () => {
  it.effect('preserves length and line structure, so offsets stay valid against the original', () =>
    Effect.sync(() => {
      const source = ['const a = "text"', '// comment', '/* block */', 'const b = `tpl`'].join('\n')
      const masked = maskSource(source)
      expect(masked).toHaveLength(source.length)
      expect(masked.split('\n')).toHaveLength(4)
    }),
  )

  it.effect('blanks comment bodies and string interiors while keeping the delimiters', () =>
    Effect.sync(() => {
      expect(maskSource('const a = "hello"')).toBe('const a = "     "')
      expect(maskSource('const a = 1 // why')).toBe('const a = 1       ')
    }),
  )

  it.effect('keeps `${...}` interpolations as live code inside a template literal', () =>
    Effect.sync(() => {
      expect(maskSource('`x${ y }z`')).toBe('` ${ y } `')
    }),
  )
})

describe('import extraction', () => {
  it.effect('finds single-line, multi-line, side-effect, re-export and dynamic imports', () =>
    Effect.sync(() => {
      const source = [
        "import { a } from '@nerima-games/mc-alpha'",
        'import {',
        '  b,',
        "} from '@nerima-games/mc-beta'",
        "import '@nerima-games/mc-gamma'",
        "export * from '@nerima-games/mc-delta'",
        "const later = await import('@nerima-games/mc-epsilon')",
      ].join('\n')

      const specifiers = parseImports(source).map((record) => record.specifier)

      expect(specifiers).toContain('@nerima-games/mc-alpha')
      expect(specifiers).toContain('@nerima-games/mc-beta')
      expect(specifiers).toContain('@nerima-games/mc-gamma')
      expect(specifiers).toContain('@nerima-games/mc-delta')
      expect(specifiers).toContain('@nerima-games/mc-epsilon')
    }),
  )

  it.effect('ignores imports that only appear inside comments', () =>
    Effect.sync(() => {
      const source = [
        "// import { a } from '@nerima-games/mc-commented-out'",
        '/*',
        " import { b } from '@nerima-games/mc-block-commented'",
        '*/',
        "import { c } from '@nerima-games/mc-real'",
      ].join('\n')

      const specifiers = parseImports(source).map((record) => record.specifier)
      expect(specifiers).toStrictEqual(['@nerima-games/mc-real'])
    }),
  )

  it.effect('reports the line an import was found on', () =>
    Effect.sync(() => {
      const source = ['const x = 1', '', "import { a } from '@nerima-games/mc-alpha'"].join('\n')
      expect(parseImports(source)[0]?.line).toBe(3)
    }),
  )

  it.effect('maps a deep specifier back to the package that owns it', () =>
    Effect.sync(() => {
      expect(extractOrgPackageName('@nerima-games/mc-sim/domain/tick')).toBe('@nerima-games/mc-sim')
      expect(extractOrgPackageName('@nerima-games/mc-sim')).toBe('@nerima-games/mc-sim')
      expect(extractOrgPackageName('effect')).toBeUndefined()
      expect(extractOrgPackageName('./relative')).toBeUndefined()
      expect(extractOrgPackageName('@other-scope/thing')).toBeUndefined()
    }),
  )
})

describe('the Date.now() ban', () => {
  const banned = (source: string) => findBannedTimeSources(source, 'domain/example.ts')

  // NOTE: every fixture below is a string literal, so the checker's own scan of
  // this file masks it out. If one of these ever starts failing `pnpm check:deps`
  // that is a genuine bug in maskSource, not a problem with the test.

  it.effect('flags a bare wall-clock read, which oxlint 0.12 cannot express as a rule', () =>
    Effect.sync(() => {
      const violations = banned('const t = Date.now()')
      expect(violations).toHaveLength(1)
      expect(violations[0]?.rule).toBe('banned-time-source')
      expect(violations[0]?.message).toContain('ClockPort')
    }),
  )

  it.effect('flags new Date() and performance.now() as the same class of violation', () =>
    Effect.sync(() => {
      expect(banned('const t = new Date()')).toHaveLength(1)
      expect(banned('const t = performance.now()')).toHaveLength(1)
    }),
  )

  it.effect('does not flag a mention inside a line comment', () =>
    Effect.sync(() => {
      expect(banned('// never call Date.now() here')).toStrictEqual([])
    }),
  )

  it.effect('does not flag a mention inside a string literal', () =>
    Effect.sync(() => {
      expect(banned('const message = "Date.now() is banned"')).toStrictEqual([])
    }),
  )

  it.effect('does not flag a mention inside a regex literal', () =>
    Effect.sync(() => {
      expect(banned('const pattern = /Date\\.now\\(/u')).toStrictEqual([])
    }),
  )

  it.effect('does flag a call hidden inside a template literal interpolation', () =>
    Effect.sync(() => {
      expect(banned('const message = `at ${Date.now()}`')).toHaveLength(1)
    }),
  )

  it.effect('honours the escape hatch, which exists for the one adapter that implements the clock Port', () =>
    Effect.sync(() => {
      expect(banned('const t = Date.now() // mc-kernel-allow-time-source: this IS the adapter')).toStrictEqual([])
    }),
  )

  it.effect('reports the line the call was on', () =>
    Effect.sync(() => {
      expect(banned(['const a = 1', 'const b = 2', 'const t = Date.now()'].join('\n'))[0]?.line).toBe(3)
    }),
  )

  it.effect('does not mistake division for a regex literal and blank the rest of the file', () =>
    Effect.sync(() => {
      const source = ['const half = total / 2', 'const third = total / 3', 'const t = Date.now()'].join('\n')
      expect(banned(source)).toHaveLength(1)
    }),
  )
})

describe('shipped vs tooling source classification', () => {
  it.effect('treats index.ts, domain/ and stages/ as shipped, and everything else as tooling or tests', () =>
    Effect.sync(() => {
      expect(isToolingOrTestPath('index.ts')).toBe(false)
      expect(isToolingOrTestPath('domain/codec.ts')).toBe(false)
      // `stages/` was already in SCAN_ROOTS before anything lived there, and it
      // was NOT in this predicate — so the first stage registration would have
      // been classified as tooling, which may import a devDependency. Shipped
      // code reaching for a dev-only package is rule 6, and mc-render's
      // `stages/stage-ids.ts` records what it cost the last time it happened:
      // the released build had no input handling at all.
      expect(isToolingOrTestPath('stages/registration.ts')).toBe(false)
      expect(isToolingOrTestPath('test/codec.test.ts')).toBe(true)
      expect(isToolingOrTestPath('scripts/check-dependency-whitelist.ts')).toBe(true)
    }),
  )
})

// ---------------------------------------------------------------------------
// What the gate calls "shipped" and what npm actually ships must be one set.
//
// These are two hand-maintained lists describing the same thing that could not
// see each other, and both halves have now gone wrong in this organisation, in
// opposite directions:
//
//   - mx-multiplayer had `stages` in SCAN_ROOTS but NOT in isToolingOrTestPath,
//     so its first stage registration would have been classified as tooling --
//     and tooling may import a devDependency. That is rule 6, the same hole
//     that left the shipped build with no input stage at all.
//   - mc-render had the mirror image: `stages/` was correctly shipped source to
//     the gate, and `files` omitted it, so `npm publish` would have produced a
//     package with none of its five stage registrations in it.
//
// Neither is visible from inside its own half, and this repository is correct
// today -- which is exactly when to pin it, because the hole opens on the day
// someone adds the next root.
// ---------------------------------------------------------------------------
describe('the published package and the dependency gate agree on what ships', () => {
  it.effect('every shipped source root the gate scans is in package.json `files`', () =>
    Effect.sync(() => {
      const shipped = SCAN_ROOTS.filter((root) => !isToolingOrTestPath(`${root}/probe.ts`))
      const files: ReadonlyArray<string> = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ).files

      const missing = shipped.filter((root) => !files.includes(root))
      expect(missing, `these roots ship code but npm would not include them: ${missing.join(', ')}`).toStrictEqual([])
    }),
  )
})
