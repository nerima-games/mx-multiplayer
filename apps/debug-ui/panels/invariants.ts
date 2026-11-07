import type { CommandUnsupportedReason } from '../../../src/application/server/command-application.js'
import type { ProtocolErrorReason, TransportErrorReason } from '../../../src/domain/errors.js'
import type { HungerRejectionReason } from '../../../src/domain/hunger-authority.js'
import type { CommandRejectionReason } from '../../../src/domain/protocol.js'
import type { PlayerDamageRejectionReason } from '../../../src/domain/protocol/player-damage.js'
import type { RateLimitExceededReason } from '../../../src/domain/rate-limit.js'
import type { SurvivalRejectionReason } from '../../../src/domain/survival-authority.js'
import { AUTHORITY_ACCEPT_REPLAY_SCENARIO } from '../../../scenarios/authority.js'
import { SCENARIO_CATALOG } from '../../../scenarios/index.js'
import { createScenarioRuntime } from '../../../scenarios/runtime.js'
import type { ScenarioEntityRevision, ScenarioFault, ScenarioId, ScenarioResult, ScenarioRuntime, ScenarioRuntimeFault, ScenarioRuntimeOptions } from '../../../scenarios/types.js'
import type { DebugPanel, DebugPanelContext, DebugPanelHandle } from './types.js'

const CONVERGENCE_SCENARIO_ID = 'world-sync.snapshot-transfer-convergence'
const SCENARIO_FRAME_LIMIT = 8
const ZERO = 0
const FIXED_SEED = ZERO
const NORMAL_SPEED = 1
const PAUSED = false
const PANEL_ENABLED = 0
const ONE = 1
const FUTURE_CONTROL_FRAME_COUNT = 2
const FUTURE_CONTROL_FAULT: ScenarioRuntimeFault = { atFrame: ONE, clientId: 'client-a', kind: 'future' }
const NO_FAULT: ScenarioFault = { kind: 'none' }
const SCENARIO_OPTIONS: ScenarioRuntimeOptions = {
  fault: NO_FAULT,
  frame: ZERO,
  panel: PANEL_ENABLED,
  play: PAUSED,
  seed: FIXED_SEED,
  speed: NORMAL_SPEED,
}

const commandUnsupportedReasons = {
  'intent-payload-does-not-preserve-command': 'Intent payload did not preserve the original command.',
  'no-matching-c2-intent-payload': 'No matching C2 intent payload was available.',
} satisfies Record<CommandUnsupportedReason, string>

const commandRejectionReasons = {
  'entity-dead': 'The target entity is dead.',
  'insufficient-items': 'The command lacks required items.',
  'invalid-command': 'The command payload is invalid.',
  'not-mounted': 'The player is not mounted.',
  'offer-exhausted': 'The offer has no remaining stock.',
  'out-of-range': 'The target is outside the allowed range.',
  'resource-not-found': 'The requested resource does not exist.',
  'snapshot-required': 'A fresh snapshot is required.',
  'stale-revision': 'The expected revision is stale.',
  'unauthorized-player': 'The command names another player.',
  'vehicle-occupied': 'The vehicle is already occupied.',
} satisfies Record<CommandRejectionReason, string>

const survivalRejectionReasons = {
  'actor-dead': 'The actor is dead.',
  'already-sleeping': 'The actor is already sleeping.',
  'authority-boundary-unsupported': 'The authority boundary does not support this operation.',
  'cooldown-active': 'The command is still on cooldown.',
  'duplicate-request': 'The request was already processed.',
  'insufficient-items': 'The actor lacks required items.',
  'invalid-bed': 'The bed is invalid.',
  'invalid-command': 'The command payload is invalid.',
  'invalid-game-mode': 'The game mode does not allow this operation.',
  'missing-block': 'The required block is missing.',
  'not-sleep-time': 'It is not a valid time to sleep.',
  'not-sleeping': 'The actor is not sleeping.',
  'occupied': 'The target is occupied.',
  'out-of-reach': 'The target is out of reach.',
  'session-mismatch': 'The session does not match.',
  'stale-revision': 'The expected revision is stale.',
  'target-alive': 'The target is still alive.',
  'target-dead': 'The target is already dead.',
  'target-not-found': 'The target does not exist.',
  'unauthorized-actor': 'The actor is not authorized.',
  'sleep-unsafe': 'The bed is unsafe.',
} satisfies Record<SurvivalRejectionReason, string>

const hungerRejectionReasons = {
  'authority-boundary-unsupported': 'The authority boundary does not support this operation.',
  'cannot-eat': 'The player cannot eat this item.',
  'duplicate-command': 'The command was already processed.',
  'insufficient-items': 'The player lacks the requested item.',
  'invalid-command': 'The command payload is invalid.',
  'invalid-elapsed-time': 'The elapsed time is invalid.',
  'session-mismatch': 'The session does not match.',
  'stale-revision': 'The expected revision is stale.',
  'unauthorized-player': 'The command names another player.',
} satisfies Record<HungerRejectionReason, string>

const playerDamageRejectionReasons = {
  'invalid-command': 'The command payload is invalid.',
  'stale-revision': 'The expected revision is stale.',
  'unauthorized-player': 'The command names another player.',
  'wrong-world': 'The command targets another world.',
} satisfies Record<PlayerDamageRejectionReason, string>

const transportErrorReasons = {
  closed: 'The peer or local side closed the connection.',
  'not-connected': 'A send was attempted while disconnected.',
  'send-failed': 'The underlying socket rejected the write.',
} satisfies Record<TransportErrorReason, string>

const rateLimitReasons = {
  'byte-rate': 'The configured byte rate was exceeded.',
  'delta-too-large': 'A delta exceeded the configured maximum size.',
  'frame-rate': 'The configured frame rate was exceeded.',
} satisfies Record<RateLimitExceededReason, string>

const protocolErrorReasons = {
  'frame-too-large': 'The frame exceeded a decoding limit.',
  'malformed-frame': 'The frame could not be decoded.',
  'unencodable-message': 'The message could not be encoded.',
  'unsupported-protocol-version': 'The frame used an unsupported protocol version.',
} satisfies Record<ProtocolErrorReason, string>

type ReasonDescriptionTable = Readonly<Record<string, string>>
type ReasonObservationMode = 'wire-result' | 'aggregate-only'

type ReasonRow = {
  readonly status: HTMLOutputElement
  readonly evidence: HTMLSpanElement
  readonly element: HTMLElement
}

type ReasonGroup = {
  readonly id: string
  readonly rows: ReadonlyMap<string, ReasonRow>
  readonly mode: ReasonObservationMode
}

type InvariantRow = {
  readonly element: HTMLElement
  readonly status: HTMLOutputElement
  readonly evidence: HTMLSpanElement
}

type PanelFields = {
  readonly convergence: InvariantRow
  readonly revisions: InvariantRow
  readonly wallClock: InvariantRow
  readonly futureControl: InvariantRow
  readonly runFutureControlButton: HTMLButtonElement
  readonly scenarioAssertions: InvariantRow
  readonly reasonGroups: ReadonlyArray<ReasonGroup>
  readonly scenarioSelect: HTMLSelectElement
  readonly runScenarioButton: HTMLButtonElement
  readonly runSummary: HTMLOutputElement
}

type ReasonObservations = Map<string, Map<string, Map<ScenarioId, string>>>

type ReasonPrefix = {
  readonly groupId: string
  readonly prefix: string
}

const REASON_PREFIXES: ReadonlyArray<ReasonPrefix> = [
  { groupId: 'command-unsupported', prefix: 'authority marked command unsupported: ' },
  { groupId: 'command-rejection', prefix: 'authority rejected command: ' },
  { groupId: 'protocol-error', prefix: 'decode rejected: ' },
  { groupId: 'protocol-error', prefix: 'codec refused frame: ' },
  { groupId: 'transport-error', prefix: 'authority transport refused frame: ' },
  { groupId: 'transport-error', prefix: 'transport refused send: ' },
]

const setOutput = (output: HTMLElement, value: string): void => {
  if (output.textContent !== value) {
    output.textContent = value
  }
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const appendSection = (target: HTMLElement, title: string): HTMLElement => {
  const section = document.createElement('section')
  const heading = document.createElement('h4')
  heading.textContent = title
  section.append(heading)
  target.append(section)
  return section
}

const appendInvariantRow = (target: HTMLElement, id: string, title: string): InvariantRow => {
  const element = document.createElement('p')
  element.dataset['testid'] = `invariants-${id}`
  const label = document.createElement('strong')
  label.textContent = `${title}: `
  const status = document.createElement('output')
  status.dataset['testid'] = `invariants-${id}-status`
  const evidence = document.createElement('span')
  evidence.dataset['testid'] = `invariants-${id}-evidence`
  element.append(label, status, document.createTextNode(' '), evidence)
  target.append(element)
  return { element, evidence, status }
}

const appendReasonGroup = (
  target: HTMLElement,
  id: string,
  title: string,
  descriptions: ReasonDescriptionTable,
  mode: ReasonObservationMode,
): ReasonGroup => {
  const section = appendSection(target, title)
  const rows = new Map<string, ReasonRow>()
  for (const [reason, description] of Object.entries(descriptions)) {
    const element = document.createElement('p')
    element.dataset['testid'] = `invariants-reason-${id}-${reason}`
    element.dataset['status'] = mode === 'aggregate-only' ? 'unobserved' : 'not-observed'
    const label = document.createElement('strong')
    label.textContent = `${reason}: `
    const status = document.createElement('output')
    status.dataset['testid'] = `invariants-reason-${id}-${reason}-status`
    const evidence = document.createElement('span')
    evidence.dataset['testid'] = `invariants-reason-${id}-${reason}-evidence`
    element.append(label, status, document.createTextNode(` ${description} `), evidence)
    section.append(element)
    rows.set(reason, { element, evidence, status })
  }
  return { id, mode, rows }
}

const createFields = (target: HTMLElement): PanelFields => {
  const root = document.createElement('div')
  root.dataset['panel'] = 'invariants'
  const runner = appendSection(root, 'Run a scenario')
  const scenarioSelect = document.createElement('select')
  scenarioSelect.dataset['testid'] = 'invariants-scenario-select'
  scenarioSelect.setAttribute('aria-label', 'Scenario to run')
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = 'Choose a scenario'
  scenarioSelect.append(placeholder)
  for (const entry of SCENARIO_CATALOG) {
    const option = document.createElement('option')
    option.value = entry.scenario.id
    option.textContent = `${entry.scenario.title} (${entry.scenario.id})`
    scenarioSelect.append(option)
  }
  const runScenarioButton = document.createElement('button')
  runScenarioButton.type = 'button'
  runScenarioButton.dataset['testid'] = 'invariants-run-scenario'
  runScenarioButton.textContent = `Run selected scenario (up to ${String(SCENARIO_FRAME_LIMIT)} frames)`
  const runSummary = document.createElement('output')
  runSummary.dataset['testid'] = 'invariants-run-summary'
  runSummary.setAttribute('aria-live', 'polite')
  runSummary.textContent = 'Choose a scenario to observe its runtime results.'
  runner.append(scenarioSelect, runScenarioButton, runSummary)

  const invariantSection = appendSection(root, 'Scenario invariants')
  const convergence = appendInvariantRow(invariantSection, 'convergence', 'Client convergence')
  const revisions = appendInvariantRow(invariantSection, 'revisions', 'Per-entity revision monotonicity')
  const wallClock = appendInvariantRow(invariantSection, 'wall-clock', 'No wall-clock use')
  const scenarioAssertions = appendInvariantRow(invariantSection, 'scenario-assertions', 'Scenario evaluator')

  const futureControlSection = appendSection(root, 'Future revision negative control')
  const futureControl = appendInvariantRow(futureControlSection, 'future-control', 'Expected scenario rejection')
  futureControl.element.dataset['status'] = 'unverified'
  setOutput(futureControl.status, 'UNVERIFIED')
  setOutput(futureControl.evidence, 'The future revision control has not run.')
  const runFutureControlButton = document.createElement('button')
  runFutureControlButton.type = 'button'
  runFutureControlButton.dataset['testid'] = 'invariants-run-future-control'
  runFutureControlButton.textContent = 'Run future revision negative control'
  futureControlSection.append(runFutureControlButton)

  const coverage = appendSection(root, 'Rejection reason coverage')
  const note = document.createElement('p')
  note.textContent = 'Occurred means an exact scenario wire result was observed. Not observed is not covered.'
  coverage.append(note)
  const reasonGroups = [
    appendReasonGroup(coverage, 'command-unsupported', 'Command application', commandUnsupportedReasons, 'wire-result'),
    appendReasonGroup(coverage, 'command-rejection', 'Command rejection', commandRejectionReasons, 'wire-result'),
    appendReasonGroup(coverage, 'survival-authority', 'Survival authority', survivalRejectionReasons, 'wire-result'),
    appendReasonGroup(coverage, 'hunger-authority', 'Hunger authority', hungerRejectionReasons, 'wire-result'),
    appendReasonGroup(coverage, 'player-damage', 'Player damage', playerDamageRejectionReasons, 'wire-result'),
    appendReasonGroup(coverage, 'transport-error', 'Transport', transportErrorReasons, 'wire-result'),
    appendReasonGroup(coverage, 'rate-limit', 'Rate limit', rateLimitReasons, 'aggregate-only'),
    appendReasonGroup(coverage, 'protocol-error', 'Codec and protocol decode', protocolErrorReasons, 'wire-result'),
  ]
  const reconnectNote = document.createElement('p')
  reconnectNote.dataset['testid'] = 'invariants-reconnect-auth'
  reconnectNote.textContent = 'Reconnect auth declares no rejection-reason union; failure is represented as undefined.'
  coverage.append(reconnectNote)

  target.append(root)
  return {
    convergence,
    revisions,
    reasonGroups,
    futureControl,
    runFutureControlButton,
    runScenarioButton,
    runSummary,
    scenarioAssertions,
    scenarioSelect,
    wallClock,
  }
}

const rememberReason = (
  observations: ReasonObservations,
  groupId: string,
  reason: string,
  scenarioId: ScenarioId,
  result: string,
): void => {
  let group = observations.get(groupId)
  if (group === undefined) {
    group = new Map<string, Map<ScenarioId, string>>()
    observations.set(groupId, group)
  }
  let reasonObservations = group.get(reason)
  if (reasonObservations === undefined) {
    reasonObservations = new Map<ScenarioId, string>()
    group.set(reason, reasonObservations)
  }
  if (!reasonObservations.has(scenarioId)) {
    reasonObservations.set(scenarioId, result)
  }
}

const observeWireResults = (snapshot: ScenarioResult, observations: ReasonObservations): void => {
  for (const entry of snapshot.wireLog) {
    for (const prefix of REASON_PREFIXES) {
      if (entry.result.startsWith(prefix.prefix)) {
        rememberReason(
          observations,
          prefix.groupId,
          entry.result.slice(prefix.prefix.length),
          snapshot.id,
          entry.result,
        )
        break
      }
    }
  }
}

const formatObservedReasons = (observations: ReadonlyMap<ScenarioId, string>): string => {
  const entries = [...observations.entries()].map(([scenarioId, result]) => `${scenarioId} (${result})`)
  return `Observed in ${entries.join(', ')}`
}

const renderReasonGroup = (
  group: ReasonGroup,
  observations: ReasonObservations,
  hasRuntime: boolean,
): void => {
  for (const [reason, row] of group.rows) {
    if (group.mode === 'aggregate-only') {
      row.element.dataset['status'] = 'unobserved'
      setOutput(row.status, 'UNOBSERVED')
      setOutput(row.evidence, 'ScenarioRuntime exposes aggregate rejection counts, not this individual reason.')
      continue
    }
    const seen = observations.get(group.id)?.get(reason)
    if (seen !== undefined && seen.size > ZERO) {
      row.element.dataset['status'] = 'occurred'
      setOutput(row.status, 'OCCURRED')
      setOutput(row.evidence, formatObservedReasons(seen))
      continue
    }
    row.element.dataset['status'] = 'not-observed'
    setOutput(row.status, 'NOT OCCURRED')
    setOutput(row.evidence, hasRuntime
      ? 'No matching wire result occurred in the scenario runs observed by this panel.'
      : 'No scenario runtime has been observed by this panel.')
  }
}

const formatClients = (snapshot: ScenarioResult): string => snapshot.clients
  .map((client) => `${client.id}: ${client.accepted} accepted, ${client.rejected} rejected`)
  .join('; ')

type RevisionCheck = {
  readonly status: 'pass' | 'fail' | 'unverified'
  readonly evidence: string
}

const checkRevisionMonotonicity = (history: ReadonlyArray<ScenarioEntityRevision>): RevisionCheck => {
  const previousRevisions = new Map<string, number>()
  for (const sample of history) {
    const key = `${sample.clientId}:${sample.entityId}`
    const previous = previousRevisions.get(key)
    if (previous !== undefined && sample.revision < previous) {
      return {
        evidence: `${sample.clientId} ${sample.entityId} decreased from revision ${String(previous)} to ${String(sample.revision)} at frame ${String(sample.frame)}.`,
        status: 'fail',
      }
    }
    previousRevisions.set(key, sample.revision)
  }
  if (history.length === ZERO) {
    return { evidence: 'No per-entity revision samples were observed.', status: 'unverified' }
  }
  const lastFrame = history.reduce((latest, sample) => Math.max(latest, sample.frame), ZERO)
  return {
    evidence: `${String(history.length)} per-entity revision samples did not decrease through frame ${String(lastFrame)}.`,
    status: 'pass',
  }
}

const renderInvariantRows = (fields: PanelFields, runtime: ScenarioRuntime | undefined): void => {
  const snapshot = runtime?.snapshot()
  if (runtime === undefined || snapshot === undefined) {
    fields.convergence.element.dataset['status'] = 'unverified'
    setOutput(fields.convergence.status, 'UNVERIFIED')
    setOutput(fields.convergence.evidence, 'No ScenarioRuntime is mounted.')
    fields.revisions.element.dataset['status'] = 'unverified'
    setOutput(fields.revisions.status, 'UNVERIFIED')
    setOutput(fields.revisions.evidence, 'No ScenarioRuntime is mounted.')
    fields.wallClock.element.dataset['status'] = 'unverified'
    setOutput(fields.wallClock.status, 'UNVERIFIED')
    setOutput(fields.wallClock.evidence, 'No injected clock observation is exposed by ScenarioRuntime.')
    fields.scenarioAssertions.element.dataset['status'] = 'unverified'
    setOutput(fields.scenarioAssertions.status, 'UNVERIFIED')
    setOutput(fields.scenarioAssertions.evidence, 'No scenario evaluator result is available.')
    return
  }

  const convergenceApplies = snapshot.id === CONVERGENCE_SCENARIO_ID
  const convergenceStatus = convergenceApplies && snapshot.verdict.status !== 'incomplete'
    ? snapshot.verdict.status
    : 'unverified'
  fields.convergence.element.dataset['status'] = convergenceStatus
  setOutput(fields.convergence.status, convergenceStatus.toUpperCase())
  setOutput(fields.convergence.evidence, convergenceApplies
    ? `${snapshot.verdict.summary}; runtime authority revision ${snapshot.authority.revision}; ${formatClients(snapshot)}`
    : `Current scenario ${snapshot.id} does not provide a client-convergence assertion.`)

  const revisionCheck = checkRevisionMonotonicity(snapshot.revisionHistory)
  fields.revisions.element.dataset['status'] = revisionCheck.status
  setOutput(fields.revisions.status, revisionCheck.status.toUpperCase())
  setOutput(fields.revisions.evidence, revisionCheck.evidence)

  const runtimeClock = runtime.clock.now()
  const clockMatchesLogicalFrame = runtimeClock === snapshot.clockNow && snapshot.clockNow === snapshot.frame
  const wallClockStatus = clockMatchesLogicalFrame ? 'pass' : 'fail'
  fields.wallClock.element.dataset['status'] = wallClockStatus
  setOutput(fields.wallClock.status, wallClockStatus.toUpperCase())
  setOutput(fields.wallClock.evidence,
    `Runtime clock ${String(runtimeClock)}, observed clock ${String(snapshot.clockNow)}, frame ${String(snapshot.frame)}.`)

  fields.scenarioAssertions.element.dataset['status'] = snapshot.verdict.status
  setOutput(fields.scenarioAssertions.status, snapshot.verdict.status.toUpperCase())
  setOutput(fields.scenarioAssertions.evidence,
    `${snapshot.id}; frame ${snapshot.frame}; ${snapshot.verdict.summary}`)
}

export const invariantsPanel: DebugPanel = {
  id: 'invariants',
  title: 'Invariants and rejection coverage',
  mount: (target, initialContext): DebugPanelHandle => {
    const fields = createFields(target)
    const observations: ReasonObservations = new Map()
    let context = initialContext
    let disposed = false
    let running = false

    const renderRunner = (): void => {
      fields.scenarioSelect.disabled = running
      fields.runScenarioButton.disabled = running || fields.scenarioSelect.value === ''
      fields.runFutureControlButton.disabled = running
    }

    const update = (nextContext: DebugPanelContext): void => {
      if (disposed) {
        return
      }
      context = nextContext
      const runtime = context.runtime
      const snapshot = runtime?.snapshot()
      if (snapshot !== undefined) {
        observeWireResults(snapshot, observations)
      }
      renderInvariantRows(fields, runtime)
      for (const group of fields.reasonGroups) {
        renderReasonGroup(group, observations, snapshot !== undefined)
      }
    }

    const runScenario = async (): Promise<void> => {
      if (disposed || running) {
        return
      }
      const selected = SCENARIO_CATALOG.find((entry) => entry.scenario.id === fields.scenarioSelect.value)
      if (selected === undefined) {
        setOutput(fields.runSummary, 'Choose a scenario from the catalog first.')
        return
      }

      running = true
      renderRunner()
      setOutput(fields.runSummary, `Running ${selected.scenario.id} for at most ${String(SCENARIO_FRAME_LIMIT)} frames.`)
      try {
        const runtime = await createScenarioRuntime(selected.scenario, SCENARIO_OPTIONS)
        const result = await runtime.run(SCENARIO_FRAME_LIMIT)
        if (disposed) {
          return
        }
        context.setScenario(selected.scenario)
        context.setState({
          fault: NO_FAULT.kind,
          frame: result.frame,
          panel: PANEL_ENABLED,
          play: 0,
          seed: FIXED_SEED,
          speed: NORMAL_SPEED,
        })
        context.setRuntime(runtime)
        setOutput(fields.runSummary,
          `${result.id}; frame limit ${String(SCENARIO_FRAME_LIMIT)}, reached ${result.frame}; ${result.verdict.status}: ${result.verdict.summary}`)
      } catch (error) {
        if (!disposed) {
          setOutput(fields.runSummary, `Scenario runtime operation failed: ${errorMessage(error)}`)
        }
      } finally {
        running = false
        if (!disposed) {
          renderRunner()
        }
      }
    }

    const selectionChanged = (): void => {
      renderRunner()
    }
    const runFutureControl = async (): Promise<void> => {
      if (disposed || running) {
        return
      }
      running = true
      renderRunner()
      setOutput(fields.futureControl.status, 'RUNNING')
      fields.futureControl.element.dataset['status'] = 'running'
      try {
        const runtime = await createScenarioRuntime(AUTHORITY_ACCEPT_REPLAY_SCENARIO, {
          ...SCENARIO_OPTIONS,
          fault: FUTURE_CONTROL_FAULT,
        })
        const result = await runtime.run(FUTURE_CONTROL_FRAME_COUNT)
        if (disposed) {
          return
        }
        const rejection = result.wireLog.find((entry) => entry.result === 'authority rejected command: stale-revision')
        const controlStatus = result.verdict.status
        fields.futureControl.element.dataset['status'] = controlStatus
        setOutput(fields.futureControl.status, controlStatus.toUpperCase())
        setOutput(fields.futureControl.evidence, `${result.verdict.summary}; ${rejection?.result ?? 'no stale-revision rejection was observed'}`)
        observeWireResults(result, observations)
        for (const group of fields.reasonGroups) {
          renderReasonGroup(group, observations, true)
        }
      } catch (error) {
        if (!disposed) {
          fields.futureControl.element.dataset['status'] = 'error'
          setOutput(fields.futureControl.status, 'ERROR')
          setOutput(fields.futureControl.evidence, errorMessage(error))
        }
      } finally {
        running = false
        if (!disposed) {
          renderRunner()
        }
      }
    }
    fields.scenarioSelect.addEventListener('change', selectionChanged)
    fields.runScenarioButton.addEventListener('click', runScenario)
    fields.runFutureControlButton.addEventListener('click', runFutureControl)

    update(initialContext)
    renderRunner()
    return {
      update,
      dispose: () => {
        disposed = true
        fields.scenarioSelect.removeEventListener('change', selectionChanged)
        fields.runScenarioButton.removeEventListener('click', runScenario)
        fields.runFutureControlButton.removeEventListener('click', runFutureControl)
      },
    }
  },
}

export default invariantsPanel
