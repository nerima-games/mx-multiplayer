# @nerima-games/mx-multiplayer

## 0.6.0

### Minor Changes

- [#14](https://github.com/nerima-games/mx-multiplayer/pull/14) [`dedecac`](https://github.com/nerima-games/mx-multiplayer/commit/dedecac7366eb833c3db86b4ba3928e398b56fa7) Thanks [@takeokunn](https://github.com/takeokunn)! - Repoint the frame-contract mirror (`StageId`, `DeltaTimeSecs`, `FrameServices`, `StageRegistration`, `GameModule`) to `@nerima-games/mc-kernel`, now that it is published. `FrameServices` widens from the mirror's `never` to kernel's `ClockPort`; neither stage this repository registers reads a clock (DN-3), so this is a type-level change only for stage authors, and a new runtime dependency on mc-kernel for stage builders.

### Patch Changes

- [#13](https://github.com/nerima-games/mx-multiplayer/pull/13) [`ff064de`](https://github.com/nerima-games/mx-multiplayer/commit/ff064de95f92c341407100f528f55e56ffb0506c) Thanks [@takeokunn](https://github.com/takeokunn)! - Complete the org toolchain devDependency pin set: knip 6.33.0 (its verify gate arrives in Wave 3; the pin belongs to the Wave 0 table) plus @effect/vitest 0.30.0 where it was missing.

## 0.5.1

### Patch Changes

- [#10](https://github.com/nerima-games/mx-multiplayer/pull/10) [`45c4bb7`](https://github.com/nerima-games/mx-multiplayer/commit/45c4bb7eaa2a7fc4a7bb161c15c205400f0a8cd3) Thanks [@takeokunn](https://github.com/takeokunn)! - Fix CI: scope oxlint's pedantic/style rules to match this repository's Effect-TS idiom and the org's test/scripts/apps relaxation policy (`new-cap`, `func-names` and `no-undefined` no longer fight `Schema.Struct`/`Effect.gen`/`Map#get` patterns; `no-underscore-dangle` and `id-length` gained targeted exceptions for `_tag` and 3D coordinate fields), apply the remaining real fixes in `src/` (named constants, sorted keys/imports, `if`/`else` in place of ternaries, extracted helpers to clear `max-statements`), and close the coverage gate's gap in `connection.ts`, `snapshot-interpolation.ts`, `transport.ts`, `authoritative-session.ts`, `hunger-authority.ts` and `survival-authority.ts` with behavioral tests (plus documented `v8 ignore` on the small number of branches proven unreachable). No public API changes.

- [#11](https://github.com/nerima-games/mx-multiplayer/pull/11) [`fea871d`](https://github.com/nerima-games/mx-multiplayer/commit/fea871d05162e0e863295416dcdecf88162a7de2) Thanks [@takeokunn](https://github.com/takeokunn)! - Toolchain frozen to org pin set (TypeScript 7.0.2, vitest 4.1.11, effect 3.22.1, node 24, pnpm 11.24.0); build switched to tsc emit; release workflow added

## 0.2.0

### Minor Changes

- [`ccfe491`](https://github.com/nerima-games/mx-multiplayer/commit/ccfe491b7cdaababb3974d18640ae622141419be) Thanks [@takeokunn](https://github.com/takeokunn)! - Add protocol-v2 End portal transfer and authoritative realm transfer messages.

### Patch Changes

- [#1](https://github.com/nerima-games/mx-multiplayer/pull/1) [`7c1efe6`](https://github.com/nerima-games/mx-multiplayer/commit/7c1efe6bd12c162cf7301527606d52a1002de1fb) Thanks [@takeokunn](https://github.com/takeokunn)! - Migrate onto the nerima-games org standard: restructure shipped source under
  `src/`, drop the `api-lock`/`check-dependency-whitelist` tooling in favour of
  `oxlint`'s `no-restricted-imports`, declare `@nerima-games/mc-sim` as an actual
  `dependency` (previously undeclared drift versus `docs/architecture.md`), pin
  GitHub Actions to commit SHAs, add Dependabot, and enable the 4-metric 99%
  coverage gate.
