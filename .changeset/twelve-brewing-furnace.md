---
"@nerima-games/mx-multiplayer": minor
---

Bump the wire protocol to 12. Replace the single-bottle brewing state with three item-stack slots, ingredient and fuel slots, fuel charges, and brewing progress in seconds. Brewing insertion and collection select a bottle index; drinking now consumes a potion from the specified inventory slot instead of the brewing stand.

Remove the public `BrewingIngredient`, `PotionType`, and `BrewingBottle` schemas. Represent brewing ingredients and bottles with `ItemStack`, and identify potion varieties by item.

Add furnace station and total burn ticks, require remaining burn ticks to be no greater than the total, and export shared brewing and furnace converters with typed conversion failures. Item stacks continue to omit components. All frames still require an exact protocol-version match, so version 11 peers are rejected and clients and servers must update together.
