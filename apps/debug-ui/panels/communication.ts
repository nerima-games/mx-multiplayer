import { SCENARIO_CATALOG } from '../../../scenarios/index.js'
import { createScenarioRuntime } from '../entrypoints/scenarios/scenario-runtime.js'
import {
  SCENARIO_RUNTIME_FAULT_KINDS,
  type ScenarioClientId,
  type ScenarioFaultKind,
  type ScenarioRuntimeFault,
  type ScenarioRuntimeFaultKind,
  type ScenarioResult,
  type ScenarioRuntime,
  type ScenarioWireLogEntry,
} from '../../../scenarios/types.js'
import type { DebugPanel, DebugPanelContext, DebugPanelHandle } from './types.js'

const DEFAULT_SCENARIO_ID = 'transport.fault.drop'
const ZERO = 0
const ONE = 1
const FRAME_COUNT = ONE
const MINIMUM_REORDERED_ENTRY_COUNT = 2
const WIRE_LOG_COLUMN_COUNT = 5
const MAX_VISIBLE_WIRE_ENTRIES = 200

type PanelFields = {
  readonly scenario: HTMLSelectElement
  readonly fault: HTMLSelectElement
  readonly targetClient: HTMLSelectElement
  readonly atFrame: HTMLInputElement
  readonly delayFrames: HTMLInputElement
  readonly runWithoutFault: HTMLButtonElement
  readonly injectAndRun: HTMLButtonElement
  readonly status: HTMLOutputElement
  readonly verdict: HTMLOutputElement
  readonly wireLog: HTMLTableSectionElement
  readonly windowInfo: HTMLOutputElement
}

const SUPPORTED_FAULT_LABELS: Record<ScenarioRuntimeFaultKind, string> = {
  none: 'No fault',
  delay: 'Delay',
  drop: 'Drop',
  reorder: 'Reorder',
  disconnect: 'Disconnect',
  corrupt: 'Corrupt frame',
  version: 'Wrong protocol version',
  future: 'Future revision',
  duplicate: 'Duplicate frame',
}

const hostFaultKind = (fault: ScenarioRuntimeFault): ScenarioFaultKind => {
  switch (fault.kind) {
    case 'none':
    case 'delay':
    case 'drop':
    case 'reorder':
    case 'disconnect':
      return fault.kind
    case 'corrupt':
    case 'version':
    case 'future':
    case 'duplicate':
      return 'none'
  }
}

const appendLabel = (target: HTMLElement, label: string, control: HTMLElement): void => {
  const line = document.createElement('label')
  const title = document.createElement('span')
  title.textContent = label
  line.append(title, control)
  target.append(line)
}

const makeSelect = (testId: string, label: string): HTMLSelectElement => {
  const select = document.createElement('select')
  select.dataset['testid'] = testId
  select.setAttribute('aria-label', label)
  return select
}

const makeInput = (testId: string, label: string, value: string): HTMLInputElement => {
  const input = document.createElement('input')
  input.type = 'number'
  input.min = '1'
  input.step = '1'
  input.value = value
  input.dataset['testid'] = testId
  input.setAttribute('aria-label', label)
  return input
}

const makeButton = (label: string, testId: string): HTMLButtonElement => {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.dataset['testid'] = testId
  return button
}

const makeOutput = (testId: string, label: string): HTMLOutputElement => {
  const output = document.createElement('output')
  output.dataset['testid'] = testId
  output.setAttribute('aria-label', label)
  output.setAttribute('aria-live', 'polite')
  output.textContent = 'No scenario run yet.'
  return output
}

const initialScenarioId = (context: DebugPanelContext): string => {
  const preferred = context.scenario?.id ?? context.state.scenario
  if (SCENARIO_CATALOG.some(({ scenario }) => scenario.id === preferred)) {
    return preferred
  }
  return SCENARIO_CATALOG.find(({ scenario }) => scenario.id === DEFAULT_SCENARIO_ID)?.scenario.id
    ?? SCENARIO_CATALOG.at(ZERO)?.scenario.id
    ?? ''
}

const findScenario = (id: string) =>
  SCENARIO_CATALOG.find(({ scenario }) => scenario.id === id)?.scenario

const createFields = (target: HTMLElement, context: DebugPanelContext): PanelFields => {
  const root = document.createElement('div')
  root.dataset['panel'] = 'communication'

  const controls = document.createElement('section')
  const controlsHeading = document.createElement('h4')
  controlsHeading.textContent = 'Scenario and transport fault'

  const scenario = makeSelect('communication-scenario', 'Scenario')
  for (const { scenario: definition } of SCENARIO_CATALOG) {
    const option = document.createElement('option')
    option.value = definition.id
    option.textContent = `${definition.id}: ${definition.title}`
    scenario.append(option)
  }
  scenario.value = initialScenarioId(context)
  appendLabel(controls, 'Scenario', scenario)

  const fault = makeSelect('communication-fault', 'Transport fault')
  const faultOptions = SCENARIO_RUNTIME_FAULT_KINDS.map((kind) => ({ value: kind, label: SUPPORTED_FAULT_LABELS[kind] }))
  for (const optionData of faultOptions) {
    const option = document.createElement('option')
    option.value = optionData.value
    option.textContent = optionData.label
    fault.append(option)
  }
  fault.value = 'none'
  appendLabel(controls, 'Fault', fault)

  const targetClient = makeSelect('communication-target-client', 'Target client')
  const clientIds: ReadonlyArray<ScenarioClientId> = ['client-a', 'client-b']
  for (const id of clientIds) {
    const option = document.createElement('option')
    option.value = id
    option.textContent = id
    targetClient.append(option)
  }
  targetClient.value = 'client-a'
  appendLabel(controls, 'Target client', targetClient)

  const atFrame = makeInput('communication-at-frame', 'Fault at frame', '1')
  appendLabel(controls, 'Fault at frame', atFrame)

  const delayFrames = makeInput('communication-delay-frames', 'Delay frames', '1')
  appendLabel(controls, 'Delay frames', delayFrames)

  const buttons = document.createElement('div')
  const runWithoutFault = makeButton('Run without fault', 'communication-run-control')
  const injectAndRun = makeButton('Inject fault and re-run', 'communication-run-fault')
  buttons.append(runWithoutFault, injectAndRun)

  const status = makeOutput('communication-status', 'Communication run status')
  const verdict = makeOutput('communication-verdict', 'Latest scenario verdict')

  controls.append(controlsHeading, buttons)
  const runSection = document.createElement('section')
  const runHeading = document.createElement('h4')
  runHeading.textContent = 'Latest run'
  runSection.append(runHeading, status, verdict)

  const logSection = document.createElement('section')
  const logHeading = document.createElement('h4')
  logHeading.textContent = 'Wire log'
  const table = document.createElement('table')
  table.dataset['testid'] = 'communication-wire-log'
  const caption = document.createElement('caption')
  caption.textContent = 'Runtime wire entries in submission order'
  const head = document.createElement('thead')
  const headerRow = document.createElement('tr')
  const columns = ['Frame', 'Sender', 'Tag', 'Size (bytes)', 'Result']
  for (const label of columns) {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.textContent = label
    headerRow.append(cell)
  }
  head.append(headerRow)
  const wireLog = document.createElement('tbody')
  wireLog.dataset['testid'] = 'communication-wire-entries'
  const emptyRow = document.createElement('tr')
  const emptyCell = document.createElement('td')
  emptyCell.colSpan = 5
  emptyCell.textContent = 'Run a scenario to see wire frames.'
  emptyRow.append(emptyCell)
  wireLog.append(emptyRow)
  table.append(caption, head, wireLog)
  const windowInfo = makeOutput('communication-wire-window', 'Visible wire log window')
  windowInfo.textContent = `Showing up to ${String(MAX_VISIBLE_WIRE_ENTRIES)} entries.`
  logSection.append(logHeading, table, windowInfo)

  root.append(controls, runSection, logSection)
  target.append(root)

  return {
    scenario,
    fault,
    targetClient,
    atFrame,
    delayFrames,
    runWithoutFault,
    injectAndRun,
    status,
    verdict,
    wireLog,
    windowInfo,
  }
}

const readPositiveInteger = (input: HTMLInputElement): number | undefined => {
  const value = Number(input.value)
  return Number.isSafeInteger(value) && value > ZERO ? value : undefined
}

const readClientId = (select: HTMLSelectElement): ScenarioClientId | undefined => {
  if (select.value === 'client-a') {
    return 'client-a'
  }
  if (select.value === 'client-b') {
    return 'client-b'
  }
  return undefined
}

const selectedFault = (fields: PanelFields): ScenarioRuntimeFault | undefined => {
  if (fields.fault.value === 'none') {
    return { kind: 'none' }
  }

  const atFrame = readPositiveInteger(fields.atFrame)
  if (atFrame === undefined) {
    return undefined
  }

  switch (fields.fault.value) {
    case 'drop': {
      const clientId = readClientId(fields.targetClient)
      return clientId === undefined ? undefined : { kind: 'drop', atFrame, clientId }
    }
    case 'reorder':
      return { kind: 'reorder', atFrame }
    case 'delay': {
      const frames = readPositiveInteger(fields.delayFrames)
      const clientId = readClientId(fields.targetClient)
      return frames === undefined || clientId === undefined ? undefined : { kind: 'delay', frames, atFrame, clientId }
    }
    case 'disconnect': {
      const clientId = readClientId(fields.targetClient)
      return clientId === undefined ? undefined : { kind: 'disconnect', atFrame, clientId }
    }
    case 'corrupt': {
      const clientId = readClientId(fields.targetClient)
      return clientId === undefined ? undefined : { kind: 'corrupt', atFrame, clientId }
    }
    case 'version': {
      const clientId = readClientId(fields.targetClient)
      return clientId === undefined ? undefined : { kind: 'version', atFrame, clientId }
    }
    case 'future': {
      const clientId = readClientId(fields.targetClient)
      return clientId === undefined ? undefined : { kind: 'future', atFrame, clientId }
    }
    case 'duplicate': {
      const clientId = readClientId(fields.targetClient)
      return clientId === undefined ? undefined : { kind: 'duplicate', atFrame, clientId }
    }
    default:
      return undefined
  }
}

const isReordered = (entry: ScenarioWireLogEntry, visibleEntries: ReadonlyArray<ScenarioWireLogEntry>): boolean => {
  if (entry.deliverySequence === undefined || entry.deliveredFrame === undefined) {
    return false
  }
  const sameDelivery = visibleEntries.filter((candidate) => candidate.frame === entry.frame
    && candidate.deliveredFrame === entry.deliveredFrame
    && candidate.deliverySequence !== undefined)
  if (sameDelivery.length < MINIMUM_REORDERED_ENTRY_COUNT) {
    return false
  }
  const bySubmission = [...sameDelivery].sort((left, right) => left.sequence - right.sequence)
  const byDelivery = [...sameDelivery].sort((left, right) =>
    (left.deliverySequence ?? ZERO) - (right.deliverySequence ?? ZERO))
  return bySubmission.some((candidate, index) => byDelivery[index]?.sequence !== candidate.sequence)
}

const formatResult = (entry: ScenarioWireLogEntry, visibleEntries: ReadonlyArray<ScenarioWireLogEntry>): string => {
  let result = `${entry.outcome}: ${entry.result}`
  if (entry.result.includes('replay')) {
    result = `duplicated/replay: ${entry.result}`
  } else if (entry.outcome === 'rejected') {
    result = `rejected: ${entry.result}`
  } else if (entry.outcome === 'dropped') {
    result = `dropped: ${entry.result}`
  } else if (entry.outcome === 'disconnected') {
    result = `disconnected: ${entry.result}`
  } else if (entry.outcome === 'delayed' || entry.deliveredFrame !== undefined && entry.deliveredFrame > entry.frame) {
    const delivery = entry.deliveredFrame === undefined ? '' : `; delivered at frame ${String(entry.deliveredFrame)}`
    result = `delayed${delivery}: ${entry.result}`
  } else if (isReordered(entry, visibleEntries)) {
    result = `reordered: ${entry.outcome}; delivery sequence ${String(entry.deliverySequence)}`
  }
  return entry.faultNotApplied === undefined ? result : `${entry.faultNotApplied}; ${result}`
}

const renderWireLog = (fields: PanelFields, snapshot: ScenarioResult, encoder: TextEncoder): void => {
  const start = Math.max(ZERO, snapshot.wireLog.length - MAX_VISIBLE_WIRE_ENTRIES)
  const visibleEntries = snapshot.wireLog.slice(start)
  const rows = visibleEntries.map((entry) => {
    const row = document.createElement('tr')
    row.dataset['testid'] = 'communication-wire-row'
    const values = [
      String(entry.frame),
      entry.from,
      entry.tag,
      String(encoder.encode(entry.text).byteLength),
      formatResult(entry, visibleEntries),
    ]
    for (const [index, value] of values.entries()) {
      const cell = document.createElement('td')
      cell.dataset['column'] = ['frame', 'sender', 'tag', 'size', 'result'][index] ?? 'value'
      cell.textContent = value
      row.append(cell)
    }
    return row
  })
  if (rows.length === 0) {
    const emptyRow = document.createElement('tr')
    const emptyCell = document.createElement('td')
    emptyCell.colSpan = WIRE_LOG_COLUMN_COUNT
    emptyCell.textContent = 'No wire frames were sent.'
    emptyRow.append(emptyCell)
    rows.push(emptyRow)
  }
  fields.wireLog.replaceChildren(...rows)
  const hiddenCount = start
  fields.windowInfo.textContent = hiddenCount === ZERO
    ? `Showing ${String(visibleEntries.length)} of ${String(snapshot.wireLog.length)} entries.`
    : `Showing the latest ${String(visibleEntries.length)} of ${String(snapshot.wireLog.length)} entries; ${String(hiddenCount)} older entries hidden.`
}

const renderSnapshot = (fields: PanelFields, snapshot: ScenarioResult, encoder: TextEncoder): void => {
  fields.status.textContent = `Scenario ${snapshot.id}; fault ${snapshot.runtimeFault.kind}; frame ${String(snapshot.frame)}.`
  fields.verdict.textContent = `${snapshot.verdict.status}: ${snapshot.verdict.summary}`
  renderWireLog(fields, snapshot, encoder)
}

export const communicationPanel: DebugPanel = {
  id: 'communication',
  title: 'Communication and wire log',
  mount: (target, initialContext): DebugPanelHandle => {
    const fields = createFields(target, initialContext)
    const encoder = new TextEncoder()
    let context = initialContext
    let runtime: ScenarioRuntime | undefined = undefined
    let latestSnapshot: ScenarioResult | undefined = undefined
    let lastScenarioId = initialContext.scenario?.id
    let busy = false
    let disposed = false

    const renderEmpty = (): void => {
      fields.status.textContent = 'No scenario run yet.'
      fields.verdict.textContent = 'Run a scenario to see its verdict.'
      const emptyRow = document.createElement('tr')
      const emptyCell = document.createElement('td')
      emptyCell.colSpan = WIRE_LOG_COLUMN_COUNT
      emptyCell.textContent = 'Run a scenario to see wire frames.'
      emptyRow.append(emptyCell)
      fields.wireLog.replaceChildren(emptyRow)
      fields.windowInfo.textContent = `Showing up to ${String(MAX_VISIBLE_WIRE_ENTRIES)} entries.`
    }

    const renderButtons = (): void => {
      fields.runWithoutFault.disabled = busy || disposed
      fields.injectAndRun.disabled = busy || disposed
      fields.scenario.disabled = busy || disposed
      fields.fault.disabled = busy || disposed
      fields.targetClient.disabled = busy || disposed || fields.fault.value === 'none' || fields.fault.value === 'reorder'
      fields.atFrame.disabled = busy || disposed || fields.fault.value === 'none'
      fields.delayFrames.disabled = busy || disposed || fields.fault.value !== 'delay'
    }

    const renderEmptyWireLog = (): void => {
      const row = document.createElement('tr')
      const cell = document.createElement('td')
      cell.colSpan = WIRE_LOG_COLUMN_COUNT
      cell.textContent = 'No completed wire log is available.'
      row.append(cell)
      fields.wireLog.replaceChildren(row)
      fields.windowInfo.textContent = `Showing up to ${String(MAX_VISIBLE_WIRE_ENTRIES)} entries.`
    }

    const runScenario = async (fault: ScenarioRuntimeFault): Promise<void> => {
      if (busy || disposed) {
        return
      }
      const definition = findScenario(fields.scenario.value)
      if (definition === undefined) {
        fields.status.textContent = `Scenario ${fields.scenario.value} is not in the shared catalog.`
        return
      }
      busy = true
      latestSnapshot = undefined
      fields.status.textContent = `Running ${definition.id} with ${fault.kind} from frame 0.`
      fields.verdict.textContent = 'Run in progress.'
      renderButtons()
      try {
        context.setScenario(definition)
        context.setState({ fault: hostFaultKind(fault), frame: 0, play: 0 })
        const nextRuntime = await createScenarioRuntime(definition, {
          fault,
          frame: 0,
          panel: context.state.panel,
          play: false,
          seed: context.state.seed,
          speed: context.state.speed,
        })
        if (disposed) {
          return
        }
        const snapshot = await nextRuntime.run(FRAME_COUNT)
        if (disposed) {
          return
        }
        latestSnapshot = snapshot
        context.setState({ frame: snapshot.frame })
        runtime = nextRuntime
        context.setRuntime(nextRuntime)
        renderSnapshot(fields, snapshot, encoder)
      } catch (error) {
        if (!disposed) {
          latestSnapshot = undefined
          fields.status.textContent = `Scenario runtime operation failed: ${error instanceof Error ? error.message : 'unknown error'}`
          fields.verdict.textContent = 'No verdict is available for this run.'
          renderEmptyWireLog()
        }
      } finally {
        busy = false
        if (!disposed) {
          renderButtons()
        }
      }
    }

    const runWithoutFault = (): Promise<void> => runScenario({ kind: 'none' })

    const injectAndRun = async (): Promise<void> => {
      const fault = selectedFault(fields)
      if (fault === undefined) {
        fields.status.textContent = 'Fault settings are invalid.'
        return
      }
      await runScenario(fault)
    }

    const selectScenario = (): void => {
      const definition = findScenario(fields.scenario.value)
      if (definition !== undefined) {
        context.setScenario(definition)
      }
    }

    const updateFaultControls = (): void => {
      renderButtons()
    }

    fields.runWithoutFault.addEventListener('click', runWithoutFault)
    fields.injectAndRun.addEventListener('click', injectAndRun)
    fields.scenario.addEventListener('change', selectScenario)
    fields.fault.addEventListener('change', updateFaultControls)
    renderButtons()
    renderEmpty()

    const update = (nextContext: DebugPanelContext): void => {
      context = nextContext
      if (nextContext.scenario?.id !== undefined && nextContext.scenario.id !== lastScenarioId) {
        fields.scenario.value = nextContext.scenario.id
        lastScenarioId = nextContext.scenario.id
      }
      if (nextContext.runtime === undefined) {
        runtime = undefined
        latestSnapshot = undefined
        renderEmpty()
        return
      }
      if (nextContext.runtime !== runtime) {
        runtime = nextContext.runtime
        latestSnapshot = runtime.snapshot()
      } else {
        latestSnapshot = runtime.snapshot()
      }
      if (latestSnapshot !== undefined) {
        renderSnapshot(fields, latestSnapshot, encoder)
      }
    }

    update(initialContext)
    return {
      update,
      dispose: () => {
        disposed = true
        fields.runWithoutFault.removeEventListener('click', runWithoutFault)
        fields.injectAndRun.removeEventListener('click', injectAndRun)
        fields.scenario.removeEventListener('change', selectScenario)
        fields.fault.removeEventListener('change', updateFaultControls)
      },
    }
  },
}

export default communicationPanel
