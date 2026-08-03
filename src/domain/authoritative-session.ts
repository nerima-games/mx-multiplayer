import type {
  AuthoritativeCommand,
  AuthoritativeCommandResult,
  AuthoritativeSnapshot,
  CommandId,
  CommandRejectionReason,
  WorldId,
} from './protocol'

export type CommandDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: CommandRejectionReason }

/** Server-side revision and command ledger. Game-rule validation stays in the caller. */
export class AuthoritativeSession {
  readonly #revisions = new Map<WorldId, number>()
  readonly #results = new Map<CommandId, AuthoritativeCommandResult>()

  restore(snapshot: AuthoritativeSnapshot): void {
    this.#revisions.set(snapshot.world, snapshot.revision)
  }

  execute(command: AuthoritativeCommand, decide: (command: AuthoritativeCommand) => CommandDecision): AuthoritativeCommandResult {
    const previous = this.#results.get(command.commandId)
    if (previous !== undefined) return previous

    const revision = this.#revisions.get(command.world)
    if (revision === undefined) return this.#reject(command, 0, 'snapshot-required', true)
    if (command.expectedRevision !== revision) {
      return this.#reject(command, revision, 'stale-revision', true)
    }

    const decision = decide(command)
    if (!decision.accepted) return this.#reject(command, revision, decision.reason, false)

    const nextRevision = revision + 1
    this.#revisions.set(command.world, nextRevision)
    const result: AuthoritativeCommandResult = {
      _tag: 'AuthoritativeCommandAccepted',
      commandId: command.commandId,
      world: command.world,
      revision: nextRevision,
    }
    this.#results.set(command.commandId, result)
    return result
  }

  revision(world: WorldId): number | undefined {
    return this.#revisions.get(world)
  }

  disconnect(world?: WorldId): void {
    if (world === undefined) this.#revisions.clear()
    else this.#revisions.delete(world)
  }

  #reject(
    command: AuthoritativeCommand,
    revision: number,
    reason: CommandRejectionReason,
    resyncRequired: boolean,
  ): AuthoritativeCommandResult {
    const result: AuthoritativeCommandResult = {
      _tag: 'AuthoritativeCommandRejected',
      commandId: command.commandId,
      world: command.world,
      revision,
      reason,
      resyncRequired,
    }
    this.#results.set(command.commandId, result)
    return result
  }
}
