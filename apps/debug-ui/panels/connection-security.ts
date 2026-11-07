import { Result, Schema } from 'effect'
import {
  canSend,
  initialConnectionState,
  type ConnectionState,
} from '../../../src/domain/connection.js'
import {
  CONNECTION_RATE_LIMITS,
  type ConnectionRateLimitFailure,
  RateLimitExceeded,
  createConnectionRateLimiter,
} from '../../../src/domain/rate-limit.js'
import { CommandRejectionReason, PlayerId, type WorldId } from '../../../src/domain/protocol.js'
import {
  SCENARIO_ANGLE_MEANINGS,
  type ScenarioAction,
  type ScenarioClientState,
  type ScenarioResult,
  type ScenarioRuntime,
} from '../../../scenarios/types.js'
import type { DebugPanel, DebugPanelContext, DebugPanelHandle } from './types.js'

const POLL_INTERVAL_MS = 1_000
const ONE = 1

type Field = {
  readonly value: HTMLOutputElement
}

type PanelFields = {
  readonly angle: Field
  readonly capability: Field
  readonly clients: Field
  readonly frameSize: Field
  readonly rates: Field
  readonly reconnect: Field
  readonly runtime: Field
  readonly security: Field
  readonly traffic: Field
  readonly byteProbe: HTMLOutputElement
  readonly frameProbe: HTMLOutputElement
  readonly probeButton: HTMLButtonElement
}

const setValue = (field: Field, value: string): void => {
  if (field.value.textContent !== value) {
    field.value.textContent = value
  }
}

const appendField = (target: HTMLElement, label: string, testId: string): Field => {
  const line = document.createElement('p')
  line.dataset['testid'] = testId
  const labelNode = document.createElement('strong')
  labelNode.textContent = `${label}: `
  const value = document.createElement('output')
  line.append(labelNode, value)
  target.append(line)
  return { value }
}

const appendProbeOutput = (target: HTMLElement, label: string, testId: string): HTMLOutputElement => {
  const line = document.createElement('p')
  const labelNode = document.createElement('strong')
  labelNode.textContent = `${label}: `
  const value = document.createElement('output')
  value.dataset['testid'] = testId
  value.setAttribute('aria-live', 'polite')
  value.textContent = 'Not run.'
  line.append(labelNode, value)
  target.append(line)
  return value
}

const appendSection = (target: HTMLElement, heading: string): HTMLElement => {
  const section = document.createElement('section')
  const title = document.createElement('h4')
  title.textContent = heading
  section.append(title)
  target.append(section)
  return section
}

const formatConfiguredLimits = (): string =>
  `${CONNECTION_RATE_LIMITS.framesPerSecond} frames/s; `
  + `${CONNECTION_RATE_LIMITS.bytesPerSecond} bytes/s; `
  + `burst ${CONNECTION_RATE_LIMITS.burstFrames} frames; `
  + `max delta ${CONNECTION_RATE_LIMITS.maxDeltaBytes} bytes. `
  + 'Live rate unsupported: ScenarioRuntime wire log has no timestamps.'

const describeAttempt = (result: Result.Result<void, ConnectionRateLimitFailure>): string => {
  if (Result.isSuccess(result)) {
    return 'accepted'
  }
  return `rejected (${result.failure.reason})`
}

const createFields = (target: HTMLElement): PanelFields => {
  const root = document.createElement('div')
  root.dataset['panel'] = 'connection-security'

  const connection = appendSection(root, 'Connection')
  const runtime = appendField(connection, 'Scenario runtime', 'connection-security-runtime')
  const angle = appendField(connection, 'Scenario angle', 'connection-security-angle')
  const clients = appendField(connection, 'Client states', 'connection-security-clients')
  const capability = appendField(connection, 'canSend', 'connection-security-capability')
  const reconnect = appendField(connection, 'Reconnect', 'connection-security-reconnect')

  const transport = appendSection(root, 'Transport')
  const rates = appendField(transport, 'Configured limits', 'connection-security-rates')
  const traffic = appendField(transport, 'Observed scenario traffic', 'connection-security-traffic')
  const frameSize = appendField(transport, 'Largest observed frame', 'connection-security-frame-size')
  const probeButton = document.createElement('button')
  probeButton.type = 'button'
  probeButton.textContent = 'Run frame and byte rate probes'
  probeButton.dataset['testid'] = 'connection-security-rate-probe-button'
  transport.append(probeButton)
  const frameProbe = appendProbeOutput(transport, 'Frame-rate probe', 'connection-security-frame-probe')
  const byteProbe = appendProbeOutput(transport, 'Byte-rate probe', 'connection-security-byte-probe')
  const note = document.createElement('p')
  note.textContent = 'Probes exercise the source rate limiter directly and do not send network frames.'
  transport.append(note)

  const security = appendSection(root, 'Security')
  const securityField = appendField(security, 'Rejections and evaluation', 'connection-security-security')

  target.append(root)
  setValue(rates, formatConfiguredLimits())

  return {
    angle,
    capability,
    clients,
    frameSize,
    frameProbe,
    probeButton,
    byteProbe,
    rates,
    reconnect,
    runtime,
    security: securityField,
    traffic,
  }
}

const createLimiter = (): ReturnType<typeof createConnectionRateLimiter> =>
  createConnectionRateLimiter(CONNECTION_RATE_LIMITS)

const runFrameRateProbe = (): string => {
  const created = createLimiter()
  if (Result.isFailure(created)) {
    return `Limiter creation failed (${created.failure.reason}).`
  }

  const bytesPerFrame = Math.min(
    CONNECTION_RATE_LIMITS.maxDeltaBytes,
    Math.floor(CONNECTION_RATE_LIMITS.bytesPerSecond / CONNECTION_RATE_LIMITS.framesPerSecond),
  )
  const limiter = created.success
  let admitted = 0
  let firstFailure: ReturnType<typeof limiter.consume> | undefined = undefined
  for (let frame = 0; frame < CONNECTION_RATE_LIMITS.burstFrames; frame += ONE) {
    const result = limiter.consume(bytesPerFrame, 0)
    if (Result.isFailure(result)) {
      firstFailure = result
      break
    }
    admitted += ONE
  }
  const overflow = limiter.consume(bytesPerFrame, 0)
  const positiveControl = firstFailure === undefined && admitted === CONNECTION_RATE_LIMITS.burstFrames
  const rejectedAsFrameRate = Result.isFailure(overflow)
    && overflow.failure instanceof RateLimitExceeded
    && overflow.failure.reason === 'frame-rate'
  if (positiveControl && rejectedAsFrameRate) {
    return `Positive control accepted ${admitted}/${CONNECTION_RATE_LIMITS.burstFrames}; overflow rejected (frame-rate).`
  }
  const innerResult = firstFailure === undefined ? 'none' : describeAttempt(firstFailure)
  return `Unexpected boundary: accepted ${admitted}/${CONNECTION_RATE_LIMITS.burstFrames}; first failure ${innerResult}; overflow ${describeAttempt(overflow)}.`
}

const runByteRateProbe = (): string => {
  const created = createLimiter()
  if (Result.isFailure(created)) {
    return `Limiter creation failed (${created.failure.reason}).`
  }

  const byteCapacity = CONNECTION_RATE_LIMITS.bytesPerSecond
    / CONNECTION_RATE_LIMITS.framesPerSecond
    * CONNECTION_RATE_LIMITS.burstFrames
  const fullFrames = Math.floor(byteCapacity / CONNECTION_RATE_LIMITS.maxDeltaBytes)
  const remainingBytes = byteCapacity - fullFrames * CONNECTION_RATE_LIMITS.maxDeltaBytes
  const limiter = created.success
  let admitted = 0
  let firstFailure: ReturnType<typeof limiter.consume> | undefined = undefined

  for (let frame = 0; frame < fullFrames; frame += ONE) {
    const result = limiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes, 0)
    if (Result.isFailure(result)) {
      firstFailure = result
      break
    }
    admitted += ONE
  }
  if (firstFailure === undefined && remainingBytes > 0) {
    const exactCapacity = limiter.consume(remainingBytes, 0)
    if (Result.isFailure(exactCapacity)) {
      firstFailure = exactCapacity
    } else {
      admitted += ONE
    }
  }
  const overflow = limiter.consume(ONE, 0)
  const expectedAccepted = fullFrames + Number(remainingBytes > 0)
  const positiveControl = firstFailure === undefined && admitted === expectedAccepted
  const rejectedAsByteRate = Result.isFailure(overflow)
    && overflow.failure instanceof RateLimitExceeded
    && overflow.failure.reason === 'byte-rate'
  if (positiveControl && rejectedAsByteRate) {
    return `Positive control accepted ${admitted} frames up to byte capacity; overflow rejected (byte-rate).`
  }
  const innerResult = firstFailure === undefined ? 'none' : describeAttempt(firstFailure)
  return `Unexpected boundary: accepted ${admitted}/${expectedAccepted} frames; first failure ${innerResult}; overflow ${describeAttempt(overflow)}.`
}

const actionsForSnapshot = (
  context: DebugPanelContext,
  snapshot: ScenarioResult,
): ReadonlyArray<ScenarioAction> | undefined => {
  const scenario = context.scenario
  if (scenario === undefined || scenario.id !== snapshot.id) {
    return undefined
  }
  return scenario.actions({
    clients: snapshot.clients.map(({ id, player }) => ({ id, player })),
    frame: snapshot.frame,
    seed: snapshot.seed,
  })
}

const worldFromActions = (
  actions: ReadonlyArray<ScenarioAction> | undefined,
  client: ScenarioClientState,
): WorldId | undefined => {
  const action = actions?.find((candidate) => candidate.clientId === client.id && candidate.kind === 'message')
  if (action?.kind !== 'message' || !('world' in action.message)) {
    return undefined
  }
  return action.message.world
}

const formatClientStates = (snapshot: ScenarioResult): string => snapshot.clients
  .map((client) => `${client.id}: ${client.connected ? 'connected' : 'not connected'}; `
    + `submitted ${client.submitted}, accepted ${client.accepted}, rejected ${client.rejected}`)
  .join(' | ')

const formatCanSend = (
  context: DebugPanelContext,
  snapshot: ScenarioResult,
): string => {
  const actions = actionsForSnapshot(context, snapshot)
  return snapshot.clients.map((client) => {
    let state: ConnectionState = initialConnectionState
    if (client.connected) {
      const world = worldFromActions(actions, client)
      if (world === undefined) {
        return `${client.id}: unsupported (scenario action does not provide a world for the domain check)`
      }
      state = {
        _tag: 'Connected',
        player: PlayerId.make(client.player),
        world,
      }
    }
    const capability = canSend(state) ? 'allowed' : 'blocked'
    return `${client.id}: ${capability} (derived via domain canSend; runtime transport gate is not exposed)`
  }).join(' | ')
}

const formatScenarioAngle = (angle: ScenarioResult['angle']): string => {
  const meaning = SCENARIO_ANGLE_MEANINGS[angle]
  return `${angle} ${meaning.title}: ${meaning.meaning}`
}

const authorityRejectionReason = (decision: string): string | undefined => {
  const prefix = 'authority rejected command: '
  if (!decision.startsWith(prefix)) {
    return undefined
  }
  const reason = decision.slice(prefix.length)
  return Schema.is(CommandRejectionReason)(reason) ? reason : undefined
}

const renderWithoutRuntime = (fields: PanelFields, context: DebugPanelContext): void => {
  const scenario = context.state.scenario === '' ? 'none' : context.state.scenario
  setValue(fields.runtime,
    `Scenario from URL: ${scenario}; URL frame: ${context.state.frame}; runtime telemetry unsupported (no scenario runtime is mounted).`)
  setValue(fields.angle, context.scenario === undefined
    ? 'Unavailable: no scenario definition is selected.'
    : formatScenarioAngle(context.scenario.angle))
  setValue(fields.clients, 'Unsupported: no scenario runtime is mounted.')
  setValue(fields.capability, 'Unsupported: no scenario runtime is mounted.')
  setValue(fields.reconnect,
    'Reconnect controls: Participants panel (UI5); auth result unsupported (no scenario runtime is mounted).')
  setValue(fields.traffic, 'Unsupported: no scenario runtime is mounted.')
  setValue(fields.frameSize, 'Unsupported: no scenario runtime is mounted.')
  setValue(fields.security, 'Unsupported: no scenario runtime is mounted.')
}

export const connectionSecurityPanel: DebugPanel = {
  id: 'connection-security',
  title: 'Connection, transport, and security',
  mount: (target, initialContext): DebugPanelHandle => {
    const fields = createFields(target)
    const encoder = new TextEncoder()
    let context = initialContext
    let runtime: ScenarioRuntime | undefined = undefined
    let interval: number | undefined = undefined
    let processedWireEntries = 0
    let observedBytes = 0
    let largestCodeUnits = 0
    let largestBytes = 0
    let latestSnapshot: ScenarioResult | undefined = undefined
    let disposed = false

    const resetTraffic = (): void => {
      processedWireEntries = 0
      observedBytes = 0
      largestCodeUnits = 0
      largestBytes = 0
    }

    const renderRuntimeLabel = (): void => {
      if (latestSnapshot !== undefined) {
        setValue(fields.runtime,
          `Runtime scenario: ${latestSnapshot.id}; frame ${latestSnapshot.frame}; verdict ${latestSnapshot.verdict.status}: ${latestSnapshot.verdict.summary}; URL frame: ${context.state.frame}`)
      }
    }

    const renderSnapshot = (snapshot: ScenarioResult): void => {
      latestSnapshot = snapshot
      if (snapshot.wireLog.length < processedWireEntries) {
        resetTraffic()
      }
      for (let index = processedWireEntries; index < snapshot.wireLog.length; index += ONE) {
        const entry = snapshot.wireLog[index]
        if (entry !== undefined) {
          const bytes = encoder.encode(entry.text).byteLength
          observedBytes += bytes
          largestCodeUnits = Math.max(largestCodeUnits, entry.text.length)
          largestBytes = Math.max(largestBytes, bytes)
        }
      }
      processedWireEntries = snapshot.wireLog.length

      renderRuntimeLabel()
      setValue(fields.angle, formatScenarioAngle(snapshot.angle))
      setValue(fields.clients, formatClientStates(snapshot))
      setValue(fields.capability, formatCanSend(context, snapshot))
      setValue(fields.reconnect,
        'Reconnect controls: Participants panel (UI5); authentication details are summarized by scenario verdicts only.')
      const submitted = snapshot.clients.reduce((total, client) => total + client.submitted, 0)
      setValue(fields.traffic,
        `${snapshot.wireLog.length} wire entries; ${submitted} client submissions; ${observedBytes} observed UTF-8 bytes. Live rate unsupported: wire log has no timestamps.`)
      setValue(fields.frameSize, largestCodeUnits === 0
        ? 'No frame observed.'
        : `${largestCodeUnits} UTF-16 code units; ${largestBytes} UTF-8 bytes. Hard inbound limit unsupported: not exposed by the frame inspection API.`)
      const rejected = snapshot.clients.reduce((total, client) => total + client.rejected, 0)
      const reasons = snapshot.clients.flatMap((client) => {
        const reason = authorityRejectionReason(client.lastDecision)
        return reason === undefined ? [] : [`${client.id}: ${reason}`]
      })
      const reasonText = reasons.length === 0
        ? 'no authority rejection reason reported'
        : `latest safe reasons ${reasons.join(', ')}`
      setValue(fields.security,
        `${snapshot.authority.rejectedCommands} authority command rejections; ${rejected} client rejections; ${reasonText}; scenario evaluation ${snapshot.verdict.status}: ${snapshot.verdict.summary}`)
    }

    const refreshRuntime = (): void => {
      if (disposed || context.runtime === undefined) {
        return
      }
      runtime = context.runtime
      renderSnapshot(runtime.snapshot())
    }

    const stopPolling = (): void => {
      if (interval !== undefined) {
        window.clearInterval(interval)
        interval = undefined
      }
    }

    const startPolling = (): void => {
      if (context.runtime !== undefined && interval === undefined) {
        interval = window.setInterval(refreshRuntime, POLL_INTERVAL_MS)
      }
    }

    const runProbes = (): void => {
      fields.frameProbe.textContent = runFrameRateProbe()
      fields.byteProbe.textContent = runByteRateProbe()
    }
    fields.probeButton.addEventListener('click', runProbes)

    const update = (nextContext: DebugPanelContext): void => {
      const runtimeChanged = nextContext.runtime !== runtime
      const playChanged = nextContext.state.play !== context.state.play
      context = nextContext

      if (nextContext.runtime === undefined) {
        stopPolling()
        runtime = undefined
        latestSnapshot = undefined
        resetTraffic()
        renderWithoutRuntime(fields, nextContext)
        return
      }
      if (runtimeChanged) {
        stopPolling()
        resetTraffic()
        latestSnapshot = undefined
        refreshRuntime()
        startPolling()
      } else if (nextContext.state.play === 0) {
        refreshRuntime()
      } else if (playChanged) {
        refreshRuntime()
      }
      if (!runtimeChanged) {
        startPolling()
      }
      renderRuntimeLabel()
    }

    update(initialContext)
    return {
      update,
      dispose: () => {
        disposed = true
        stopPolling()
        fields.probeButton.removeEventListener('click', runProbes)
      },
    }
  },
}

export default connectionSecurityPanel
