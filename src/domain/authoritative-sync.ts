import type { WorldId, WorldSnapshot } from './protocol'

export type RevisionAdmission =
  | { readonly accepted: true; readonly revision: number }
  | {
      readonly accepted: false
      readonly reason: 'snapshot-required' | 'duplicate-or-stale' | 'revision-gap'
      readonly expectedRevision?: number
      readonly receivedRevision: number
    }

/**
 * Guards application of authoritative world updates without owning game state.
 *
 * A reconnect clears the baseline, so incremental updates cannot be applied
 * until a complete snapshot establishes which revision the client has.
 */
export class AuthoritativeRevisionTracker {
  readonly #revisions = new Map<WorldId, number>()

  ingestSnapshot(snapshot: WorldSnapshot): RevisionAdmission {
    if (this.#revisions.has(snapshot.world)) {
      const current = this.#revisions.get(snapshot.world) as number
      if (snapshot.revision <= current) {
        return {
          accepted: false,
          reason: 'duplicate-or-stale',
          receivedRevision: snapshot.revision,
        }
      }
    }

    this.#revisions.set(snapshot.world, snapshot.revision)
    return { accepted: true, revision: snapshot.revision }
  }

  // eslint-disable-next-line max-statements -- Each admission branch preserves a distinct recovery reason.
  ingestRevision(world: WorldId, revision: number): RevisionAdmission {
    if (!this.#revisions.has(world)) {
      return {
        accepted: false,
        reason: 'snapshot-required',
        receivedRevision: revision,
      }
    }

    const current = this.#revisions.get(world) as number
    if (revision <= current) {
      return { accepted: false, reason: 'duplicate-or-stale', receivedRevision: revision }
    }

    const nextRevisionOffset = 1
    const expectedRevision = current + nextRevisionOffset
    if (revision !== expectedRevision) {
      return {
        accepted: false,
        expectedRevision,
        reason: 'revision-gap',
        receivedRevision: revision,
      }
    }

    this.#revisions.set(world, revision)
    return { accepted: true, revision }
  }

  revision(world: WorldId): number | undefined {
    return this.#revisions.get(world)
  }

  /** Remove one world baseline, or every baseline after transport loss. */
  disconnect(world?: WorldId): void {
    const noArguments = 0
    if (arguments.length === noArguments) {
      this.#revisions.clear()
    } else {
      this.#revisions.delete(world as WorldId)
    }
  }
}
