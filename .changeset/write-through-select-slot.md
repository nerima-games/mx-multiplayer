---
"@nerima-games/mx-multiplayer": minor
---

Write `PlayerInventoryCommand`'s `select-slot` action through to the simulation's hotbar service.

`select-slot` was the one previously-recorded reason for a whole-action carve-out that named its own fix: it belongs to `HotbarServiceApi.setSelectedSlot`, not `InventoryServiceApi`, which has no concept of an active slot at all. That reason held; wiring it needed a third host-supplied per-player lookup beyond `inventoryFor`, which the prior change's scope did not extend to.

`WorldWriteServices` gains `hotbarFor`, required, which is why this is a minor rather than a patch: an existing host that constructs the value must now supply it. It follows the same per-player lookup shape `vitalsFor`, `inventoryFor` and `vehiclesFor` already use, narrowed to `setSelectedSlot` alone — the only method `select-slot` calls — because the simulation package exposes hotbar state as one context tag per provide, one player's, rather than a registry this package could index itself.

The write is unconditional, the same shape `applyPlayerInventory` already used for `swap-items`/`equip-item`/`unequip-item`: `setSelectedSlot` clamps an out-of-range index via the simulation's own `clampHotbarIndex` rather than rejecting one, so there is no `CommandRejectionReason` this applier could report even if it wanted to — unlike `VehicleCommand`'s `mount`/`dismount`, which read state and do have a real accept-or-reject decision. `select-slot` is dispatched to its own applier before the `InventoryServiceApi`-backed actions are checked, since it writes through a different service, and it gates that write on the same `decided` flag every other applier here sets from inside its `decide` closure — not on the result tag alone — so a replayed command id, served from the ledger's cache without re-deciding, does not call `setSelectedSlot` a second time. A replay test asserts the service is called exactly once across two executions of the same command id, counted through a wrapper rather than inferred from resulting state, plus a companion proving a genuinely new command id still writes.
