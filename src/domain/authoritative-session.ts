import type {
  AuthoritativeCommand,
  AuthoritativeCommandResult,
  AuthoritativeSnapshot,
  CommandId,
  CommandRejectionReason,
  PlayerId,
  WorldId,
} from './protocol.js'
import { Effect } from 'effect'
import type { Intent } from '@nerima-games/mc-sim'

export type CommandDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: CommandRejectionReason }

export type ServerConnectionIdentity = symbol

type ConnectionBinding = {
  readonly player: PlayerId
  readonly world: WorldId
}

type AcceptedEntry = {
  readonly fingerprint: string
  readonly result: AuthoritativeCommandResult
}

export type AuthoritativeCommandIntentAccepted = {
  readonly _tag: 'AuthoritativeCommandIntentAccepted'
  readonly commandId: CommandId
  readonly intent: Intent
}

export type AuthoritativeCommandIntentReplayed = {
  readonly _tag: 'AuthoritativeCommandIntentReplayed'
  readonly commandId: CommandId
}

export type AuthoritativeCommandIntentResult =
  | AuthoritativeCommandIntentAccepted
  | AuthoritativeCommandIntentReplayed
  | AuthoritativeCommandResult

type AcceptedIntentEntry = {
  readonly fingerprint: string
  readonly result: AuthoritativeCommandIntentAccepted
}

type Rejection = {
  readonly command: AuthoritativeCommand
  readonly reason: CommandRejectionReason
  readonly resyncRequired: boolean
  readonly revision: number
}

type PreparedExecution =
  | { readonly result: AuthoritativeCommandResult }
  | { readonly key: string; readonly revisionBefore: number }

type PreparedIntentExecution =
  | { readonly result: AuthoritativeCommandIntentResult }
  | { readonly key: string }

const NO_PRIOR_REVISION = 0
const REVISION_INCREMENT = 1

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]),
    )
  }
  return value
}

const fingerprint = (command: AuthoritativeCommand): string => `${JSON.stringify(stableValue(command))}`

const ledgerKey = (command: AuthoritativeCommand): string =>
  JSON.stringify([command.player, command.world, command.commandId])

export class AuthoritativeSession {
  readonly #revisionFor: (world: WorldId) => number | undefined
  readonly #initialized = new Set<WorldId>()
  readonly #connections = new Map<ServerConnectionIdentity, ConnectionBinding>()
  readonly #inFlight = new Set<string>()
  readonly #inFlightWorlds = new Set<WorldId>()
  readonly #results = new Map<PlayerId, Map<WorldId, Map<CommandId, AcceptedEntry>>>()
  readonly #intentResults = new Map<PlayerId, Map<WorldId, Map<CommandId, AcceptedIntentEntry>>>()

  constructor(revisionFor: (world: WorldId) => number | undefined) {
    this.#revisionFor = revisionFor
  }

  /**
   * Marks a world ready only when its restored snapshot agrees with WCC's current revision.
   * The snapshot is not retained as a second copy of owner state.
   */
  restore(snapshot: AuthoritativeSnapshot): void {
    const revision = this.#readRevision(snapshot.world)
    if (revision === snapshot.revision) {
      this.#initialized.add(snapshot.world)
    } else {
      this.#initialized.delete(snapshot.world)
    }
  }

  connect(player: PlayerId, world: WorldId): ServerConnectionIdentity {
    const identity = Symbol('server-connection')
    this.#connections.set(identity, { player, world })
    return identity
  }

  /**
   * Returns an existing accepted receipt or a typed refusal; undefined means the command
   * is authenticated, initialized, and current. Unsupported paths use this before returning
   * so they cannot inspect a player service before authority checks pass.
   */
  preflight(
    identity: ServerConnectionIdentity,
    command: AuthoritativeCommand,
  ): AuthoritativeCommandResult | undefined {
    const identityFailure = this.#identityFailure(identity, command)
    if (identityFailure !== undefined) {
      return identityFailure
    }
    return this.#preflightCurrent(command)
  }

  /**
   * Checks a network-intent command against the same connection, snapshot, and
   * world-revision authority as a committed command. Identical accepted intent
   * replays return an acknowledgment without the Intent, so callers cannot
   * enqueue the same request again.
   */
  preflightIntent(
    identity: ServerConnectionIdentity,
    command: AuthoritativeCommand,
  ): AuthoritativeCommandIntentResult | undefined {
    const identityFailure = this.#identityFailure(identity, command)
    if (identityFailure !== undefined) {
      return identityFailure
    }

    const previousIntent = this.#previousIntentEntry(command)
    if (previousIntent !== undefined) {
      if (previousIntent.fingerprint === fingerprint(command)) {
        return { _tag: 'AuthoritativeCommandIntentReplayed', commandId: command.commandId }
      }
      return AuthoritativeSession.#reject({
        command,
        reason: 'invalid-command',
        resyncRequired: false,
        revision: this.#readRevision(command.world) ?? NO_PRIOR_REVISION,
      })
    }

    return this.#preflightCurrent(command)
  }

  #preflightCurrent(
    command: AuthoritativeCommand,
    revisionFailure: (command: AuthoritativeCommand, revision: number) => AuthoritativeCommandResult | undefined =
      AuthoritativeSession.#revisionFailure,
  ): AuthoritativeCommandResult | undefined {
    const currentRevision = this.#readRevision(command.world)
    const duplicateFailure = this.#duplicateFailure(command, currentRevision)
    if (duplicateFailure !== undefined) {
      return duplicateFailure
    }
    if (currentRevision === undefined) {
      return this.#snapshotFailure(command, currentRevision)
    }
    const snapshotFailure = this.#snapshotFailure(command, currentRevision)
    if (snapshotFailure !== undefined) {
      return snapshotFailure
    }
    return revisionFailure(command, currentRevision)
  }

  execute<Failure>(
    identity: ServerConnectionIdentity,
    command: AuthoritativeCommand,
    apply: (command: AuthoritativeCommand) => Effect.Effect<CommandDecision, Failure>,
  ): Effect.Effect<AuthoritativeCommandResult, Failure> {
    return Effect.suspend(() => {
      const prepared = this.#prepare(identity, command)
      if ('result' in prepared) {
        return Effect.succeed(prepared.result)
      }

      const application = this.#applyPrepared(command, prepared.revisionBefore, apply)
      return Effect.ensuring(
        application,
        Effect.sync(() => {
          this.#inFlight.delete(prepared.key)
          this.#inFlightWorlds.delete(command.world)
        }),
      )
    })
  }

  /**
   * Records a validated C2 intent for this command without changing the WCC
   * revision. The intent must match the command and authenticated player.
   * Intent construction and enqueueing remain the caller's work.
   */
  executeIntent(
    identity: ServerConnectionIdentity,
    command: AuthoritativeCommand,
    intent: Intent,
  ): Effect.Effect<AuthoritativeCommandIntentResult> {
    return Effect.suspend(() => {
      const failure = this.#identityFailure(identity, command) ?? this.#intentMetadataFailure(command, intent)
      if (failure !== undefined) {
        return Effect.succeed(failure)
      }

      const prepared = this.#prepareIntent(identity, command)
      if ('result' in prepared) {
        return Effect.succeed(prepared.result)
      }

      const result: AuthoritativeCommandIntentAccepted = {
        _tag: 'AuthoritativeCommandIntentAccepted',
        commandId: command.commandId,
        intent,
      }
      this.#storeIntent(command, fingerprint(command), result)
      return Effect.ensuring(
        Effect.succeed(result),
        Effect.sync(() => {
          this.#inFlight.delete(prepared.key)
          this.#inFlightWorlds.delete(command.world)
        }),
      )
    })
  }

  revision(world: WorldId): number | undefined {
    if (!this.#initialized.has(world)) {
      return undefined
    }
    return this.#readRevision(world)
  }

  disconnect(world?: WorldId): void {
    if (world === undefined) {
      this.#connections.clear()
      this.#initialized.clear()
      return
    }

    for (const [identity, binding] of this.#connections) {
      if (binding.world === world) {
        this.#connections.delete(identity)
      }
    }
    this.#initialized.delete(world)
  }

  #readRevision(world: WorldId): number | undefined {
    const revision = this.#revisionFor(world)
    if (revision === undefined || !Number.isSafeInteger(revision) || revision < NO_PRIOR_REVISION) {
      return undefined
    }
    return revision
  }

  #identityFailure(
    identity: ServerConnectionIdentity,
    command: AuthoritativeCommand,
  ): AuthoritativeCommandResult | undefined {
    const binding = this.#connections.get(identity)
    if (binding !== undefined && binding.player === command.player && binding.world === command.world) {
      return undefined
    }
    return AuthoritativeSession.#reject({
      command,
      reason: 'unauthorized-player',
      resyncRequired: false,
      revision: NO_PRIOR_REVISION,
    })
  }

  #intentMetadataFailure(
    command: AuthoritativeCommand,
    intent: Intent,
  ): AuthoritativeCommandResult | undefined {
    if (AuthoritativeSession.#intentMatchesCommand(command, intent)) {
      return undefined
    }
    return AuthoritativeSession.#reject({
      command,
      reason: 'invalid-command',
      resyncRequired: false,
      revision: this.#readRevision(command.world) ?? NO_PRIOR_REVISION,
    })
  }

  static #intentMatchesCommand(
    command: AuthoritativeCommand,
    intent: Intent,
  ): boolean {
    return String(intent.id) === String(command.commandId)
      && intent.source === 'network'
      && intent.expectedRevision === command.expectedRevision
      && String(intent.payload.actor) === String(command.player)
  }

  #duplicateFailure(
    command: AuthoritativeCommand,
    currentRevision: number | undefined,
  ): AuthoritativeCommandResult | undefined {
    if (this.#previousIntentEntry(command) !== undefined) {
      return AuthoritativeSession.#reject({
        command,
        reason: 'invalid-command',
        resyncRequired: false,
        revision: currentRevision ?? NO_PRIOR_REVISION,
      })
    }
    const existing = this.#previousEntry(command)
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprint(command)) {
        return existing.result
      }
      return AuthoritativeSession.#reject({
        command,
        reason: 'invalid-command',
        resyncRequired: false,
        revision: currentRevision ?? NO_PRIOR_REVISION,
      })
    }
    if (!this.#inFlight.has(ledgerKey(command)) && !this.#inFlightWorlds.has(command.world)) {
      return undefined
    }
    return AuthoritativeSession.#reject({
      command,
      reason: 'invalid-command',
      resyncRequired: false,
      revision: currentRevision ?? NO_PRIOR_REVISION,
    })
  }

  #snapshotFailure(
    command: AuthoritativeCommand,
    currentRevision: number | undefined,
  ): AuthoritativeCommandResult | undefined {
    if (this.#initialized.has(command.world) && currentRevision !== undefined) {
      return undefined
    }
    return AuthoritativeSession.#reject({
      command,
      reason: 'snapshot-required',
      resyncRequired: true,
      revision: currentRevision ?? NO_PRIOR_REVISION,
    })
  }

  static #revisionFailure(
    command: AuthoritativeCommand,
    currentRevision: number,
  ): AuthoritativeCommandResult | undefined {
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < NO_PRIOR_REVISION) {
      return AuthoritativeSession.#reject({
        command,
        reason: 'invalid-command',
        resyncRequired: false,
        revision: currentRevision,
      })
    }
    if (currentRevision >= Number.MAX_SAFE_INTEGER) {
      return AuthoritativeSession.#reject({
        command,
        reason: 'invalid-command',
        resyncRequired: false,
        revision: currentRevision,
      })
    }
    if (command.expectedRevision === currentRevision) {
      return undefined
    }
    return AuthoritativeSession.#reject({
      command,
      reason: 'stale-revision',
      resyncRequired: true,
      revision: currentRevision,
    })
  }

  #prepare(identity: ServerConnectionIdentity, command: AuthoritativeCommand): PreparedExecution {
    const refusal = this.preflight(identity, command)
    if (refusal !== undefined) {
      return { result: refusal }
    }

    const revisionBefore = this.#readRevision(command.world)
    if (revisionBefore === undefined) {
      return {
        result: AuthoritativeSession.#reject({
          command,
          reason: 'snapshot-required',
          resyncRequired: true,
          revision: NO_PRIOR_REVISION,
        }),
      }
    }

    const key = ledgerKey(command)
    this.#inFlight.add(key)
    this.#inFlightWorlds.add(command.world)
    return { key, revisionBefore }
  }

  #prepareIntent(identity: ServerConnectionIdentity, command: AuthoritativeCommand): PreparedIntentExecution {
    const refusal = this.preflightIntent(identity, command)
    if (refusal !== undefined) {
      return { result: refusal }
    }

    return this.#prepareCurrentIntent(command)
  }

  #prepareCurrentIntent(command: AuthoritativeCommand): PreparedIntentExecution {
    const revisionBefore = this.#readRevision(command.world)
    if (revisionBefore === undefined) {
      return {
        result: AuthoritativeSession.#reject({
          command,
          reason: 'snapshot-required',
          resyncRequired: true,
          revision: NO_PRIOR_REVISION,
        }),
      }
    }
    const revisionFailure = AuthoritativeSession.#revisionFailure(command, revisionBefore)
    if (revisionFailure !== undefined) {
      return { result: revisionFailure }
    }

    return this.#reserveIntent(command)
  }

  #reserveIntent(command: AuthoritativeCommand): PreparedIntentExecution {
    const key = ledgerKey(command)
    this.#inFlight.add(key)
    this.#inFlightWorlds.add(command.world)
    return { key }
  }

  #applyPrepared<Failure>(
    command: AuthoritativeCommand,
    revisionBefore: number,
    apply: (command: AuthoritativeCommand) => Effect.Effect<CommandDecision, Failure>,
  ): Effect.Effect<AuthoritativeCommandResult, Failure> {
    const session = this
    return Effect.gen(function* () {
      const decision = yield* apply(command)
      if (!decision.accepted) {
        return AuthoritativeSession.#reject({
          command,
          reason: decision.reason,
          resyncRequired: false,
          revision: revisionBefore,
        })
      }

      const revisionAfter = session.#readRevision(command.world)
      if (revisionAfter !== revisionBefore + REVISION_INCREMENT) {
        return AuthoritativeSession.#reject({
          command,
          reason: 'invalid-command',
          resyncRequired: false,
          revision: revisionAfter ?? revisionBefore,
        })
      }

      const result: AuthoritativeCommandResult = {
        _tag: 'AuthoritativeCommandAccepted',
        commandId: command.commandId,
        revision: revisionAfter,
        world: command.world,
      }
      session.#storeAccepted(command, fingerprint(command), result)
      return result
    })
  }

  #previousEntry(command: AuthoritativeCommand): AcceptedEntry | undefined {
    return this.#results.get(command.player)?.get(command.world)?.get(command.commandId)
  }

  #previousIntentEntry(command: AuthoritativeCommand): AcceptedIntentEntry | undefined {
    return this.#intentResults.get(command.player)?.get(command.world)?.get(command.commandId)
  }

  static #reject({ command, reason, resyncRequired, revision }: Rejection): AuthoritativeCommandResult {
    return {
      _tag: 'AuthoritativeCommandRejected',
      commandId: command.commandId,
      reason,
      resyncRequired,
      revision,
      world: command.world,
    }
  }

  #storeAccepted(
    command: AuthoritativeCommand,
    commandFingerprint: string,
    result: AuthoritativeCommandResult,
  ): void {
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
    worldResults.set(command.commandId, { fingerprint: commandFingerprint, result })
  }

  #storeIntent(
    command: AuthoritativeCommand,
    commandFingerprint: string,
    result: AuthoritativeCommandIntentAccepted,
  ): void {
    let playerResults = this.#intentResults.get(command.player)
    if (playerResults === undefined) {
      playerResults = new Map()
      this.#intentResults.set(command.player, playerResults)
    }
    let worldResults = playerResults.get(command.world)
    if (worldResults === undefined) {
      worldResults = new Map()
      playerResults.set(command.world, worldResults)
    }
    worldResults.set(command.commandId, { fingerprint: commandFingerprint, result })
  }
}
