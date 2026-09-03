---
"@nerima-games/mx-multiplayer": minor
---

Write inventory and vehicle commands through to the simulation services.

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
