import type { WorldWritePort } from '@nerima-games/mc-kernel'

// Contract C7 names this alias as an exception to the barrel's kernel type re-export policy.
export type MultiplayerWorldWriter = WorldWritePort['Service']
