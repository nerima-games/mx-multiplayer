# @nerima-games/mx-multiplayer

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
