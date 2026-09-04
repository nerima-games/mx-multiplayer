# @nerima-games/mx-multiplayer

## 0.11.1

### Patch Changes

- [#31](https://github.com/nerima-games/mx-multiplayer/pull/31) [`7a584a8`](https://github.com/nerima-games/mx-multiplayer/commit/7a584a8b1f5593dc41f7973be4fd6c3fd125078c) Thanks [@takeokunn](https://github.com/takeokunn)! - Close two replay-guard gaps in `command-application.ts`'s test suite: neither `EntityPickupCommand`'s despawn nor `PlayerVitalsCommand`'s `respawn` action had a test proving the write-through happens exactly once when the same command id is replayed.
  
  Both appliers already gate their mc-sim write on the `decided` flag set inside the `decide` closure, not on the result tag alone, matching every other applier in this file. But the existing tests for these two paths asserted post-state (`entities.count`, or vitals after two *different* command ids) rather than a call count — and both operations are naturally idempotent from the state's perspective (despawning an already-gone entity is a no-op `Ref.modify`; a second respawn leaves health at the same maximum). That made the state-based assertions blind to whether the write actually ran twice on a replay. Hand mutation-testing confirmed the gap directly: removing the `decided` gate from either applier left the full suite green.
  
  Both paths now have a call-count spy test — wrapping `despawn`/`respawn` to record invocations — asserting exactly one call across two executions of the same command id, the same pattern the `swap-items`/`equip-item`/`unequip-item`/`select-slot`/`mount`/`dismount` replay tests already use. No production code changed.

## 0.11.0

### Minor Changes

- [#29](https://github.com/nerima-games/mx-multiplayer/pull/29) [`140b09c`](https://github.com/nerima-games/mx-multiplayer/commit/140b09c15c49fd3c0ebe0760cdf048b49302d1b3) Thanks [@takeokunn](https://github.com/takeokunn)! - Write `PlayerInventoryCommand`'s `select-slot` action through to the simulation's hotbar service.
  
  `select-slot` was the one previously-recorded reason for a whole-action carve-out that named its own fix: it belongs to `HotbarServiceApi.setSelectedSlot`, not `InventoryServiceApi`, which has no concept of an active slot at all. That reason held; wiring it needed a third host-supplied per-player lookup beyond `inventoryFor`, which the prior change's scope did not extend to.
  
  `WorldWriteServices` gains `hotbarFor`, required, which is why this is a minor rather than a patch: an existing host that constructs the value must now supply it. It follows the same per-player lookup shape `vitalsFor`, `inventoryFor` and `vehiclesFor` already use, narrowed to `setSelectedSlot` alone — the only method `select-slot` calls — because the simulation package exposes hotbar state as one context tag per provide, one player's, rather than a registry this package could index itself.
  
  The write is unconditional, the same shape `applyPlayerInventory` already used for `swap-items`/`equip-item`/`unequip-item`: `setSelectedSlot` clamps an out-of-range index via the simulation's own `clampHotbarIndex` rather than rejecting one, so there is no `CommandRejectionReason` this applier could report even if it wanted to — unlike `VehicleCommand`'s `mount`/`dismount`, which read state and do have a real accept-or-reject decision. `select-slot` is dispatched to its own applier before the `InventoryServiceApi`-backed actions are checked, since it writes through a different service, and it gates that write on the same `decided` flag every other applier here sets from inside its `decide` closure — not on the result tag alone — so a replayed command id, served from the ledger's cache without re-deciding, does not call `setSelectedSlot` a second time. A replay test asserts the service is called exactly once across two executions of the same command id, counted through a wrapper rather than inferred from resulting state, plus a companion proving a genuinely new command id still writes.

## 0.10.0

### Minor Changes

- [#27](https://github.com/nerima-games/mx-multiplayer/pull/27) [`0ff481f`](https://github.com/nerima-games/mx-multiplayer/commit/0ff481f9109abf40ea4b478519a435ca0cb92c22) Thanks [@takeokunn](https://github.com/takeokunn)! - Write inventory and vehicle commands through to the simulation services.
  
  Two of the twenty authoritative command tags reached a simulation service
  before this. Five actions across two more tags now do:
  `PlayerInventoryCommand`'s `swap-items`, `equip-item` and `unequip-item`, and
  `VehicleCommand`'s `mount` and `dismount`.
  
  `WorldWriteServices` gains `inventoryFor` and `vehiclesFor`, both required,
  which is why this is a minor rather than a patch: an existing host that
  constructs the value must now supply them. They follow the per-player lookup
  shape `vitalsFor` already established, because the simulation package exposes
  inventory and vehicle state as one context tag per provide — one player's —
  rather than as a registry this package could index itself. This package
  still does not decide how a host indexes its players, only that it can ask
  for one.
  
  Unlike the inventory and vitals writes, `mount` and `dismount` carry a real
  accept-or-reject decision, since `CommandRejectionReason` already has
  `not-mounted` and `vehicle-occupied`. The applier therefore reads the vehicle
  roster before deciding, the same ordering `applyEntityPickup` uses, because
  the decision closure must stay synchronous while a simulation read is an
  effect.
  
  Every new applier gates its write on the flag set inside that closure rather
  than on the returned result tag. The ledger replays a cached result without
  re-deciding when a command id repeats, so gating on the tag alone would redo
  the write on every retransmit. Each new path has a replay test asserting the
  service is called exactly once across two executions of the same command id,
  counted through a wrapper rather than inferred from resulting state, plus a
  companion proving a genuinely new command id still writes.
  
  Four actions remain unwired with their reasons recorded rather than guessed:
  `select-slot` belongs to the hotbar service rather than the inventory one,
  `move-item` carries a partial count the exposed stack move cannot express,
  `drop-item` needs to spawn a world entity whose behaviour type this package
  does not know, and `VehicleCommand`'s `move` would need physics constants
  this package would have to invent.
  
  Two existing reasons were corrected. `VehicleUseCommand`'s said it needed
  identifier plumbing; in fact its wire schema carries no target field at all,
  so no plumbing can wire it. `PlayerInventoryCommand`'s listed a `sort` action
  that does not exist on the wire while omitting three that do.

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
