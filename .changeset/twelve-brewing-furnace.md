---
"@nerima-games/mx-multiplayer": minor
---

Bump the wire protocol to 12. Replace the single-bottle brewing state with three item-stack slots, ingredient and fuel slots, fuel charges, and brewing progress in seconds. Brewing insertion and collection select a bottle index; drinking now consumes a potion from the specified inventory slot instead of the brewing stand.

Remove the public `BrewingIngredient`, `PotionType`, and `BrewingBottle` schemas. Represent brewing ingredients and bottles with the new `ItemStackWire` schema and type, and identify potion varieties by item. Export `BrewingSlotWire` and `FurnaceStateWire` schemas and types with names that distinguish them from kernel domain types.

Add furnace station and total burn ticks and require remaining burn ticks to be no greater than the total. Export shared brewing and bidirectional furnace converters with typed conversion failures. `brewingStateToWire` returns a `Result` and rejects progress outside the wire range; both `ToWire` converters reject non-default components instead of dropping them. Furnace conversion uses the simulation recipe table and rounds seconds to the nearest integer tick, capping valid cooking progress below the matched recipe's completion tick. This cap does not make progress at or beyond completion valid. Reverse conversion uses the kernel's `secondsForTicks`.

Item stacks continue to omit components. All frames still require an exact protocol-version match, so version 11 peers are rejected and clients and servers must update together. Server consumers must validate recipe-specific cooking progress before passing restored furnace state to simulation. Compare server and host furnace states through wire ticks using the same recipe table; accumulated simulation seconds need not equal reconstructed seconds exactly.
