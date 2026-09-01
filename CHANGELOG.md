# @nerima-games/mx-multiplayer

## 0.9.0

### Minor Changes

- [#25](https://github.com/nerima-games/mx-multiplayer/pull/25) [`755d445`](https://github.com/nerima-games/mx-multiplayer/commit/755d4454a56a74fd2f114d5a0229d34728a480e3) Thanks [@takeokunn](https://github.com/takeokunn)! - Add `applyAuthoritativeCommand`, the first code in this package that writes an accepted `AuthoritativeCommand` through to `@nerima-games/mc-sim`. Before this change, `AuthoritativeSession` admitted commands to its ordering/idempotency ledger but nothing in this package ever touched mc-sim — a declared runtime dependency this package had never imported.
  
  Two of the twenty `AuthoritativeCommand` tags are wired: `EntityPickupCommand` writes through `EntityManagerApi.find`/`despawn` (the atomic `Ref.modify` on `despawn` is the arbitration primitive for two peers racing the same pickup — this package calls it rather than deciding who wins), and `PlayerVitalsCommand`'s `respawn`/`activity` actions write through a host-supplied per-player `VitalsServiceApi` lookup. Every other tag, including `PlayerVitalsCommand`'s `eat` action, returns `CommandNotWritable` with a documented reason rather than reaching into a rules module — most have no mc-sim application service at all, `PlayerInventoryCommand` and `VehicleCommand`/`VehicleUseCommand` have one shaped for a single instance where multiplayer needs a per-player/per-vehicle registry this change does not build, and `EntityAttackCommand` needs a host-supplied entity-behaviour step function `EntityManagerApi.sweep` requires and this package does not have.
  
  A world write only happens on a freshly accepted decision, never on a cached replay of an already-seen `commandId` — `AuthoritativeSession#execute` skips its `decide` callback on replay, and gating the mc-sim write on that same signal (rather than on the result tag) is what keeps `VitalsService.addExhaustion`, which adds rather than sets, from double-charging a retransmitted frame.
  
  `SurvivalAuthority`/`SurvivalCommand` (`domain/survival-authority.ts`) is a separate, complete, in-memory authority system that is not reachable from `stages/registration.ts`'s inbound/outbound pipeline and does not write through mc-sim either. This change does not touch it — reconciling the two authority systems is a pre-existing, parked architectural question, not something closing this seam required.

## 0.8.2

### Patch Changes

- [#23](https://github.com/nerima-games/mx-multiplayer/pull/23) [`10a367a`](https://github.com/nerima-games/mx-multiplayer/commit/10a367ae4665dbf0f0dbf88938c8e3a8a7687421) Thanks [@takeokunn](https://github.com/takeokunn)! - Align internal pins to the current published versions
  
  - `@nerima-games/mc-sim` to 0.4.2
  Each of these upstream releases contained a pin change and no source change,
  so no behaviour moves with this bump.

## 0.8.1

### Patch Changes

- [#21](https://github.com/nerima-games/mx-multiplayer/pull/21) [`ebaf317`](https://github.com/nerima-games/mx-multiplayer/commit/ebaf317415d9514d20a6422710f6ea6beb086be0) Thanks [@takeokunn](https://github.com/takeokunn)! - Pin `@nerima-games/mc-kernel` 0.7.0 and `@nerima-games/mc-sim` 0.4.1. This repository imports only `StageId`, `GameModule`, and `StageRegistration` from kernel — none of which changed between 0.5.1 and 0.7.0 (`frame.ts`, `identifiers.ts`, `clock.ts` diff empty) — and never imports mc-sim at all: `protocol/wither.ts`'s and `protocol/enchanting.ts`'s mc-sim-shaped mirrors (`WitherPhase`, `WitherDamageKind`, `WitherSkullVariant`, `WITHER_MAX_HEALTH`, `WitherState`, `WitherSkullProjectileDescriptor`, `Durability`) are declared independently on purpose, so the wire format does not track the domain type. Checked mc-sim's actual `src/domain/wither.ts` and `src/domain/equipment.ts` at 0.4.1 against every mirrored shape here; nothing diverged, so no mirror changed and `PROTOCOL_VERSION` stays at 8. No source changes were required beyond the two pins.

## 0.8.0

### Minor Changes

- [#19](https://github.com/nerima-games/mx-multiplayer/pull/19) [`2122274`](https://github.com/nerima-games/mx-multiplayer/commit/21222743aecd4158fb02af8bb3fb4df7f7e93a5d) Thanks [@takeokunn](https://github.com/takeokunn)! - Add server-side transport security resolution (`resolveTransportSecurity`, `isAllowedWebSocketOrigin`, `isLoopbackHost`, `TransportSecurityError`), reconnect-token issuance and rotation (`createReconnectAuth`, injected against `ReconnectAuthCrypto` / `ReconnectAuthStore` Ports), and a frame-tag peek utility (`frameTag`, `unknownRecord`), lowered from the composing app's `multiplayer-server/{transport-security,reconnect-auth,wire-frame-validation}.ts`. None of these three files touch `AuthoritativeCommand` or `SurvivalCommand` — they authenticate and gate a connection before either command union is ever consulted. `multiplayer-server/core.ts`'s per-tag wire-length map is not ported: it depended on the now-removed hand-rolled per-domain codecs, which the `NetworkMessage` Schema union has already superseded.

## 0.7.0

### Minor Changes

- [#17](https://github.com/nerima-games/mx-multiplayer/pull/17) [`c66cf54`](https://github.com/nerima-games/mx-multiplayer/commit/c66cf54b06b8cc2e554ad30a972dcc921d3c34ee) Thanks [@takeokunn](https://github.com/takeokunn)! - Add wire-protocol messages for anvil renaming (`AnvilCommand` / `AnvilCommandAccepted` / `AnvilCommandRejected` / `PlayerAnvilNamesDelta`), crafting-grid submission (`CraftingCommand` / `CraftingCommandAccepted` / `CraftingCommandRejected`), and player-damage confirmation (`PlayerDamageCommand` / `PlayerDamageCommandAccepted` / `PlayerDamageCommandRejected`), lowered from the composing app's hand-rolled per-domain codecs. All three now flow through the shared `NetworkMessage` union and `codec.ts`, replacing bespoke JSON parsers with `Schema`-validated decoding. `PROTOCOL_VERSION` is unchanged — adding new message tags does not require a bump (`docs/versioning.md` §7).

- [#17](https://github.com/nerima-games/mx-multiplayer/pull/17) [`c66cf54`](https://github.com/nerima-games/mx-multiplayer/commit/c66cf54b06b8cc2e554ad30a972dcc921d3c34ee) Thanks [@takeokunn](https://github.com/takeokunn)! - Add wire-protocol messages for brewing-stand interaction and status effects (`BrewingCommand` / `...Accepted` / `...Rejected` / `BrewingStandDelta` / `PlayerStatusEffectsDelta`), enchanting-table selection (`EnchantingCommand` / `...Accepted` / `...Rejected` / `PlayerEnchantmentsDelta`), the Ender Dragon encounter (`DamageEnderDragonCommand` / `...Accepted` / `...Rejected` / `EnderDragonSnapshotDelta`), and wither boss commands plus its runtime snapshot (`SummonWitherCommand` / `DamageWitherCommand` / `WitherCommandAccepted` / `WitherCommandRejected` / `WitherSnapshotDelta`), lowered from the composing app's hand-rolled per-domain codecs.
  
  `BrewingStandState`, `StatusEffectState`, `EnchantedItem`, and the wither runtime shapes are declared independently here rather than imported from `@nerima-games/mx-gameplay` or `@nerima-games/mc-sim` — a wire format and a domain type have a different change budget, the same rule `protocol.ts` already applies to `Vec3` and `BlockPos` against `@nerima-games/mc-kernel`. `wither-runtime.ts`'s actual boss-fight rules are being lowered to `@nerima-games/mx-gameplay` separately; only the wire shape is here. `PROTOCOL_VERSION` is unchanged — adding new message tags does not require a bump (`docs/versioning.md` §7).

- [#16](https://github.com/nerima-games/mx-multiplayer/pull/16) [`5a58241`](https://github.com/nerima-games/mx-multiplayer/commit/5a582415d05ff2b46e5630f84e5aadd68c9acfa1) Thanks [@takeokunn](https://github.com/takeokunn)! - Add `makeBrowserWebSocketTransport`, a `TransportPort` implementation over a real WebSocket, and `validateMultiplayerUrl` for checking a candidate multiplayer server URL against the loopback/secure-context rule. Both are lowered from the composing app, which previously carried this logic itself.

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
