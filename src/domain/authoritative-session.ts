import type {
  AuthoritativeCommand,
  AuthoritativeCommandResult,
  AuthoritativeSnapshot,
  CommandId,
  CommandRejectionReason,
  PlayerId,
  WorldId,
} from './protocol'

export type CommandDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: CommandRejectionReason }

/** `#reject`'s `revision` argument when a world has no snapshot yet: there is no revision to report. */
const NO_PRIOR_REVISION = 0

/** A ledger revision advances by exactly one per accepted command. */
const NEXT_REVISION_STEP = 1

type Rejection = {
  readonly reason: CommandRejectionReason
  readonly resyncRequired: boolean
}

type Validation =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly result: AuthoritativeCommandResult }

/** Server-side revision and command ledger. Game-rule validation stays in the caller. */
export class AuthoritativeSession {
  readonly #revisions = new Map<WorldId, number>()
  readonly #results = new Map<PlayerId, Map<WorldId, Map<CommandId, AuthoritativeCommandResult>>>()

  restore(snapshot: AuthoritativeSnapshot): void {
    this.#revisions.set(snapshot.world, snapshot.revision)
  }

  execute(command: AuthoritativeCommand, decide: (command: AuthoritativeCommand) => CommandDecision): AuthoritativeCommandResult {
    const previous = this.#previousResult(command)
    if (previous !== undefined) {
      return previous
    }

    const validation = this.#validate(command)
    if (!validation.ok) {
      return validation.result
    }

    const decision = decide(command)
    if (!decision.accepted) {
      return this.#reject(command, validation.revision, { reason: decision.reason, resyncRequired: false })
    }

    return this.#accept(command, validation.revision)
  }

  #previousResult(command: AuthoritativeCommand): AuthoritativeCommandResult | undefined {
    return this.#results.get(command.player)?.get(command.world)?.get(command.commandId)
  }

  #validate(command: AuthoritativeCommand): Validation {
    const revision = this.#revisions.get(command.world)
    if (revision === undefined) {
      return {
        ok: false,
        result: this.#reject(command, NO_PRIOR_REVISION, { reason: 'snapshot-required', resyncRequired: true }),
      }
    }
    if (command.expectedRevision !== revision) {
      return {
        ok: false,
        result: this.#reject(command, revision, { reason: 'stale-revision', resyncRequired: true }),
      }
    }
    return { ok: true, revision }
  }

  #accept(command: AuthoritativeCommand, revision: number): AuthoritativeCommandResult {
    const nextRevision = revision + NEXT_REVISION_STEP
    this.#revisions.set(command.world, nextRevision)
    const result: AuthoritativeCommandResult = {
      _tag: 'AuthoritativeCommandAccepted',
      commandId: command.commandId,
      revision: nextRevision,
      world: command.world,
    }
    this.#storeResult(command, result)
    return result
  }

  revision(world: WorldId): number | undefined {
    return this.#revisions.get(world)
  }

  disconnect(world?: WorldId): void {
    if (world === undefined) {this.#revisions.clear()}
    else {this.#revisions.delete(world)}
  }

  #reject(command: AuthoritativeCommand, revision: number, rejection: Rejection): AuthoritativeCommandResult {
    const result: AuthoritativeCommandResult = {
      _tag: 'AuthoritativeCommandRejected',
      commandId: command.commandId,
      reason: rejection.reason,
      resyncRequired: rejection.resyncRequired,
      revision,
      world: command.world,
    }
    this.#storeResult(command, result)
    return result
  }

  #storeResult(command: AuthoritativeCommand, result: AuthoritativeCommandResult): void {
    let playerResults = this.#results.get(command.player)
    if (playerResults === undefined) {
      playerResults = new Map()
      this.#results.set(command.player, playerResults)
    }
    let worldResults = playerResults.get(command.world)
    if (worldResults === undefined) {
      worldResults = new Map()
      playerResults.set(command.world, worldResults)
    }
    worldResults.set(command.commandId, result)
  }
}
