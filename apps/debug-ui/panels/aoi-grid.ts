import { Result } from 'effect'
import { chunkInterestKeyForBlockChange, decodeFrame } from '../../../src/index.js'
import { createScenarioRuntime } from '../../../scenarios/runtime.js'
import {
  SCENARIO_ANGLE_MEANINGS,
  type ScenarioClientId,
  type ScenarioResult,
} from '../../../scenarios/types.js'
import { VISIBILITY_LOAD_OWNER_REGISTRY, visibilityLoadScenario } from '../../../scenarios/visibility-load.js'
import type { DebugPanel, DebugPanelHandle } from './types.js'

type DisplayChange = Readonly<{
  blockX: number
  blockY: number
  blockZ: number
  chunkKey: string
}>

type DisplayDelivery = Readonly<{
  clientId: ScenarioClientId
  outcome: string
  result: string
  changes: ReadonlyArray<DisplayChange>
  error?: string
}>

type ChunkCell = {
  readonly key: string
  readonly clients: Set<ScenarioClientId>
}

const makeElement = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text?: string): HTMLElementTagNameMap[Tag] => {
  const element = document.createElement(tag)
  if (text !== undefined) {
    element.textContent = text
  }
  return element
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const chunkLabel = (key: string): string => {
  const decoded: unknown = JSON.parse(key)
  if (
    Array.isArray(decoded)
    && decoded.length === 3
    && typeof decoded[0] === 'string'
    && typeof decoded[1] === 'number'
    && typeof decoded[2] === 'number'
  ) {
    return `${decoded[0]} chunk (${String(decoded[1])}, ${String(decoded[2])})`
  }
  return `chunk ${key}`
}

const deliveriesFor = (result: ScenarioResult): ReadonlyArray<DisplayDelivery> => {
  const entries = result.wireLog.filter((entry) =>
    entry.frame === result.frame && entry.tag === 'ReplicatedWorldDelta'
  )
  return entries.map((entry) => {
    const decoded = decodeFrame(entry.text, VISIBILITY_LOAD_OWNER_REGISTRY)
    if (Result.isFailure(decoded)) {
      return {
        changes: [],
        clientId: entry.from,
        error: `Could not decode the runtime frame: ${decoded.failure.reason}`,
        outcome: entry.outcome,
        result: entry.result,
      }
    }
    if (decoded.success._tag !== 'ReplicatedWorldDelta') {
      return {
        changes: [],
        clientId: entry.from,
        error: `Expected ReplicatedWorldDelta, received ${decoded.success._tag}`,
        outcome: entry.outcome,
        result: entry.result,
      }
    }
    return {
      changes: decoded.success.blockChanges.map((change) => ({
        blockX: change.position.x,
        blockY: change.position.y,
        blockZ: change.position.z,
        chunkKey: String(chunkInterestKeyForBlockChange(change)),
      })),
      clientId: entry.from,
      outcome: entry.outcome,
      result: entry.result,
    }
  })
}

const makeChunkCells = (deliveries: ReadonlyArray<DisplayDelivery>): ReadonlyArray<ChunkCell> => {
  const cells = new Map<string, ChunkCell>()
  for (const delivery of deliveries) {
    for (const change of delivery.changes) {
      let cell = cells.get(change.chunkKey)
      if (cell === undefined) {
        cell = { clients: new Set<ScenarioClientId>(), key: change.chunkKey }
        cells.set(change.chunkKey, cell)
      }
      cell.clients.add(delivery.clientId)
    }
  }
  return [...cells.values()]
}

const scenarioAngle = SCENARIO_ANGLE_MEANINGS[visibilityLoadScenario.angle]

const panel: DebugPanel = {
  id: 'aoi-grid',
  title: 'AOI grid',
  mount(target, initialContext): DebugPanelHandle {
    const root = makeElement('div')
    root.className = 'aoi-grid-panel'
    root.setAttribute('data-testid', 'aoi-grid')

    const scenarioDescription = makeElement(
      'p',
      `${visibilityLoadScenario.id} · ${visibilityLoadScenario.title} · ${visibilityLoadScenario.angle}: ${scenarioAngle.title} · ${scenarioAngle.meaning}`,
    )
    const runtimeNote = makeElement(
      'p',
      'Each client row shows its recipient-specific projection and the runtime transport outcome. The current scenario sends those client actions to the authority transport.',
    )
    const controls = makeElement('div')
    const runButton = makeElement('button', 'Run AOI scenario')
    runButton.type = 'button'
    const stepButton = makeElement('button', 'Step AOI frame')
    stepButton.type = 'button'
    stepButton.disabled = true
    controls.append(runButton, stepButton)

    const status = makeElement('p', 'No AOI runtime is loaded. Run the S4 scenario to create one.')
    status.setAttribute('role', 'status')
    status.setAttribute('data-testid', 'aoi-runtime-status')
    const faultStatus = makeElement('p')
    faultStatus.className = 'aoi-runtime-fault'
    const errorList = makeElement('ul')
    errorList.setAttribute('role', 'alert')
    errorList.className = 'aoi-errors'

    const gridHeading = makeElement('h4', 'Chunk grid')
    const grid = makeElement('div')
    grid.className = 'aoi-chunk-grid'
    grid.setAttribute('role', 'grid')
    grid.style.display = 'grid'
    grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(12rem, 1fr))'
    grid.style.gap = '0.5rem'

    const deliveryHeading = makeElement('h4', 'Block change projections')
    const deliveryList = makeElement('ul')
    deliveryList.className = 'aoi-deliveries'
    root.append(
      scenarioDescription,
      runtimeNote,
      controls,
      status,
      faultStatus,
      errorList,
      gridHeading,
      grid,
      deliveryHeading,
      deliveryList,
    )
    target.replaceChildren(root)

    let context = initialContext
    let renderedRuntime = context.runtime
    let renderedScenarioId = context.scenario?.id
    let busy = false
    let disposed = false

    const syncControls = (): void => {
      runButton.disabled = busy
      stepButton.disabled = busy
        || context.scenario?.id !== visibilityLoadScenario.id
        || context.runtime === undefined
    }

    const renderDeliveries = (result: ScenarioResult): void => {
      const deliveries = deliveriesFor(result)
      const cells = makeChunkCells(deliveries)
      grid.replaceChildren(...cells.map((cell) => {
        const element = makeElement('div')
        element.className = 'aoi-chunk-cell'
        element.setAttribute('role', 'gridcell')
        element.setAttribute('data-testid', 'aoi-chunk')
        element.setAttribute('data-chunk', cell.key)
        const recipients = [...cell.clients].join(', ')
        element.textContent = `${chunkLabel(cell.key)} · ${recipients}`
        return element
      }))
      deliveryList.replaceChildren(...deliveries.flatMap((delivery) => {
        if (delivery.changes.length === 0) {
          const item = makeElement('li')
          item.setAttribute('data-testid', 'aoi-delivery')
          item.setAttribute('data-client', delivery.clientId)
          item.setAttribute('data-block-x', '')
          item.setAttribute('data-chunk', '')
          item.textContent = delivery.error === undefined
            ? `${delivery.clientId} · no block changes · ${delivery.outcome}: ${delivery.result}`
            : `${delivery.clientId} · ${delivery.error} · ${delivery.outcome}: ${delivery.result}`
          return [item]
        }
        return delivery.changes.map((change) => {
          const item = makeElement('li')
          item.setAttribute('data-testid', 'aoi-delivery')
          item.setAttribute('data-client', delivery.clientId)
          item.setAttribute('data-block-x', String(change.blockX))
          item.setAttribute('data-chunk', change.chunkKey)
          item.textContent = `${delivery.clientId} · block (${String(change.blockX)}, ${String(change.blockY)}, ${String(change.blockZ)}) · ${chunkLabel(change.chunkKey)} · ${delivery.outcome}: ${delivery.result}`
          return item
        })
      }))
      if (deliveries.length === 0) {
        const empty = makeElement('p', `No ReplicatedWorldDelta entries for runtime frame ${String(result.frame)}.`)
        empty.className = 'aoi-empty'
        grid.replaceChildren(empty)
      }
      errorList.replaceChildren(...deliveries.flatMap((delivery) => {
        if (delivery.error === undefined) {
          return []
        }
        return [makeElement('li', `${delivery.clientId}: ${delivery.error}`)]
      }))
    }

    const renderResult = (result: ScenarioResult): void => {
      status.textContent = `Frame ${String(result.frame)} · ${result.verdict.status}: ${result.verdict.summary}`
      faultStatus.textContent = `Runtime fault: ${result.fault.kind}`
      renderDeliveries(result)
    }

    const renderContext = (): void => {
      if (context.scenario?.id !== visibilityLoadScenario.id || context.runtime === undefined) {
        status.textContent = context.scenario === undefined
          ? 'No AOI runtime is loaded. Run the S4 scenario to create one.'
          : `Active scenario is ${context.scenario.id}; run the AOI scenario to replace it.`
        faultStatus.textContent = ''
        errorList.replaceChildren()
        grid.replaceChildren()
        deliveryList.replaceChildren()
        return
      }
      try {
        renderResult(context.runtime.snapshot())
      } catch (error) {
        status.textContent = `Runtime snapshot failed: ${errorMessage(error)}`
      }
    }

    const handleRun = async (): Promise<void> => {
      if (busy || disposed) {
        return
      }
      busy = true
      syncControls()
      status.textContent = 'Creating the S4 AOI runtime…'
      errorList.replaceChildren()
      const seed = context.state.seed
      try {
        context.setScenario(visibilityLoadScenario)
        const runtime = await createScenarioRuntime(visibilityLoadScenario, { seed })
        if (disposed) {
          return
        }
        context.setRuntime(runtime)
      } catch (error) {
        status.textContent = `Runtime creation failed: ${errorMessage(error)}`
      } finally {
        busy = false
        syncControls()
      }
    }

    const handleStep = async (): Promise<void> => {
      const runtime = context.runtime
      if (
        busy
        || disposed
        || runtime === undefined
        || context.scenario?.id !== visibilityLoadScenario.id
      ) {
        return
      }
      busy = true
      syncControls()
      try {
        const result = await runtime.step()
        if (disposed) {
          return
        }
        renderResult(result)
        context.setRuntime(runtime)
      } catch (error) {
        status.textContent = `Runtime step failed: ${errorMessage(error)}`
      } finally {
        busy = false
        syncControls()
      }
    }

    runButton.addEventListener('click', handleRun)
    stepButton.addEventListener('click', handleStep)

    return {
      update(nextContext) {
        const runtimeChanged = nextContext.runtime !== renderedRuntime
        const scenarioChanged = nextContext.scenario?.id !== renderedScenarioId
        context = nextContext
        renderedRuntime = nextContext.runtime
        renderedScenarioId = nextContext.scenario?.id
        if (runtimeChanged || scenarioChanged) {
          renderContext()
        }
        syncControls()
      },
      dispose() {
        disposed = true
        runButton.removeEventListener('click', handleRun)
        stepButton.removeEventListener('click', handleStep)
      },
    }
  },
}

export default panel
