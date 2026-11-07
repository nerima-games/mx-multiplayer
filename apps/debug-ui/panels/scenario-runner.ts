import { SCENARIO_CATALOG } from '../../../scenarios/index.js'
import { createScenarioRuntime } from '../entrypoints/scenarios/scenario-runtime.js'
import {
  SCENARIO_ANGLE_MEANINGS,
  SCENARIO_GROUPS,
  type ScenarioAuthorityState,
  type ScenarioClientState,
  type ScenarioFault,
  type ScenarioFaultKind,
  type ScenarioGroup,
  type ScenarioResult,
} from '../../../scenarios/types.js'
import type { DebugPanel, DebugPanelHandle } from './types.js'

const CLIENT_FIELDS: ReadonlyArray<{ readonly key: keyof ScenarioClientState; readonly label: string }> = [
  { key: 'id', label: 'Client' },
  { key: 'player', label: 'Player' },
  { key: 'connected', label: 'Connected' },
  { key: 'lastFrame', label: 'Last frame' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'received', label: 'Received' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'lastDecision', label: 'Last decision' },
]

const AUTHORITY_FIELDS: ReadonlyArray<{ readonly key: keyof ScenarioAuthorityState; readonly label: string }> = [
  { key: 'revision', label: 'Revision' },
  { key: 'acceptedCommands', label: 'Accepted commands' },
  { key: 'rejectedCommands', label: 'Rejected commands' },
  { key: 'lastDecision', label: 'Last decision' },
]

const makeElement = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  text?: string,
): HTMLElementTagNameMap[Tag] => {
  const element = document.createElement(tag)
  if (text !== undefined) {
    element.textContent = text
  }
  return element
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const faultFor = (kind: ScenarioFaultKind): ScenarioFault => {
  switch (kind) {
    case 'delay':
      return { kind: 'delay', frames: 1 }
    case 'disconnect':
      return { kind: 'disconnect' }
    case 'drop':
      return { kind: 'drop' }
    case 'none':
      return { kind: 'none' }
    case 'reorder':
      return { kind: 'reorder' }
  }
}

const renderFields = <State extends ScenarioClientState | ScenarioAuthorityState>(
  state: State,
  fields: ReadonlyArray<{ readonly key: keyof State; readonly label: string }>,
): HTMLDListElement => {
  const list = makeElement('dl')
  for (const field of fields) {
    const term = makeElement('dt', field.label)
    const detail = makeElement('dd', String(state[field.key]))
    detail.dataset['field'] = String(field.key)
    list.append(term, detail)
  }
  return list
}

const renderClient = (client: ScenarioClientState): HTMLElement => {
  const section = makeElement('section')
  section.className = 'scenario-client'
  section.setAttribute('data-testid', 'scenario-client')
  section.setAttribute('data-client-id', client.id)
  section.setAttribute('aria-label', `${client.id} state`)
  section.append(makeElement('h4', `${client.id} · ${client.player}`), renderFields(client, CLIENT_FIELDS))
  return section
}

const renderAuthority = (authority: ScenarioAuthorityState): HTMLElement => {
  const section = makeElement('section')
  section.className = 'scenario-authority'
  section.setAttribute('data-testid', 'scenario-authority')
  section.append(makeElement('h4', 'Authority'), renderFields(authority, AUTHORITY_FIELDS))
  return section
}

const panel: DebugPanel = {
  id: 'scenario-runner',
  title: 'Scenario runner',
  mount(target, initialContext): DebugPanelHandle {
    const root = makeElement('div')
    root.className = 'scenario-runner-panel'
    root.setAttribute('data-testid', 'scenario-runner')

    const note = makeElement(
      'p',
      'Choose a catalog scenario and frame count for any group. Each run uses the shared deterministic scenario runtime.',
    )
    const controls = makeElement('div')
    controls.className = 'scenario-runner-controls'

    const runButtons: Array<HTMLButtonElement> = []
    const selectors: Array<HTMLSelectElement> = []
    const frameInputs: Array<HTMLInputElement> = []
    const listeners: Array<() => void> = []

    for (const group of SCENARIO_GROUPS) {
      const scenarios = SCENARIO_CATALOG.filter((entry) => entry.scenario.group === group)
      const section = makeElement('section')
      section.className = 'scenario-runner-group'
      section.setAttribute('data-testid', `scenario-group-${group}`)
      section.setAttribute('aria-label', `${group} scenarios`)
      section.append(makeElement('h4', group))

      const select = makeElement('select')
      select.setAttribute('aria-label', `${group} scenario`)
      select.setAttribute('data-testid', `scenario-select-${group}`)
      select.dataset['hasScenarios'] = String(scenarios.length > 0)
      for (const entry of scenarios) {
        const option = makeElement('option', `${entry.scenario.title} (${entry.scenario.id})`)
        option.value = entry.scenario.id
        select.append(option)
      }
      if (scenarios.length === 0) {
        const option = makeElement('option', 'No scenarios registered')
        option.value = ''
        select.append(option)
        select.disabled = true
      }

      const frameLabel = makeElement('label', 'Frames to run')
      const frameInput = makeElement('input')
      frameInput.type = 'number'
      frameInput.min = '1'
      frameInput.step = '1'
      frameInput.value = '1'
      frameInput.setAttribute('data-testid', `scenario-frames-${group}`)
      frameLabel.append(frameInput)

      const runButton = makeElement('button', `Run ${group} scenario`)
      runButton.type = 'button'
      runButton.disabled = scenarios.length === 0
      runButton.dataset['hasScenarios'] = String(scenarios.length > 0)
      runButton.setAttribute('data-testid', `run-scenario-${group}`)
      section.append(select, frameLabel, runButton)
      controls.append(section)

      runButtons.push(runButton)
      selectors.push(select)
      frameInputs.push(frameInput)
    }

    const runStatus = makeElement('p', 'Select a scenario and run it to inspect its clients and authority.')
    runStatus.setAttribute('role', 'status')
    runStatus.setAttribute('data-testid', 'scenario-run-status')
    const errorOutput = makeElement('p')
    errorOutput.setAttribute('role', 'alert')
    errorOutput.setAttribute('data-testid', 'scenario-error')
    errorOutput.hidden = true

    const result = makeElement('section')
    result.className = 'scenario-result'
    result.setAttribute('data-testid', 'scenario-result')
    const scenarioHeading = makeElement('h3', 'No scenario has run yet.')
    scenarioHeading.setAttribute('data-testid', 'scenario-title')
    const angle = makeElement('p')
    angle.setAttribute('data-testid', 'scenario-angle')
    const verdict = makeElement('p')
    verdict.setAttribute('data-testid', 'scenario-verdict')
    const clientsHeading = makeElement('h3', 'Clients')
    const clients = makeElement('div')
    clients.className = 'scenario-clients'
    clients.setAttribute('data-testid', 'scenario-clients')
    const authority = makeElement('div')
    authority.setAttribute('data-testid', 'scenario-authority-output')
    result.append(scenarioHeading, angle, verdict, clientsHeading, clients, authority)

    root.append(note, controls, runStatus, errorOutput, result)
    target.replaceChildren(root)

    let context = initialContext
    let busy = false
    let disposed = false
    let renderedRuntime = context.runtime
    let renderedScenarioId = context.scenario?.id

    const syncControls = (): void => {
      for (const button of runButtons) {
        button.disabled = busy || button.dataset['hasScenarios'] !== 'true'
      }
      for (const selector of selectors) {
        selector.disabled = busy || selector.dataset['hasScenarios'] !== 'true'
      }
      for (const input of frameInputs) {
        input.disabled = busy
      }
    }

    const showError = (message: string): void => {
      errorOutput.textContent = message
      errorOutput.hidden = false
    }

    const renderResult = (scenarioResult: ScenarioResult): void => {
      const meaning = SCENARIO_ANGLE_MEANINGS[scenarioResult.angle]
      scenarioHeading.textContent = `${scenarioResult.title} · ${scenarioResult.id}`
      angle.textContent = `${scenarioResult.angle} · ${meaning.title}: ${meaning.meaning}`
      angle.setAttribute('data-angle', scenarioResult.angle)
      verdict.textContent = `${scenarioResult.verdict.status}: ${scenarioResult.verdict.summary}`
      verdict.setAttribute('data-status', scenarioResult.verdict.status)
      clients.replaceChildren(...scenarioResult.clients.map(renderClient))
      authority.replaceChildren(renderAuthority(scenarioResult.authority))
      runStatus.textContent = `Finished ${scenarioResult.id} at frame ${String(scenarioResult.frame)}.`
      errorOutput.textContent = ''
      errorOutput.hidden = true
    }

    const renderRuntimeSnapshot = (): void => {
      if (context.runtime === undefined || context.scenario === undefined) {
        return
      }
      try {
        renderResult(context.runtime.snapshot())
      } catch (error) {
        showError(`Scenario snapshot failed: ${errorMessage(error)}`)
        runStatus.textContent = `Could not read ${context.scenario.id}.`
      }
    }

    const handleRun = async (
      group: ScenarioGroup,
      select: HTMLSelectElement,
      frameInput: HTMLInputElement,
    ): Promise<void> => {
      if (busy || disposed) {
        return
      }
      const selected = SCENARIO_CATALOG.find((entry) =>
        entry.scenario.group === group && entry.scenario.id === select.value
      )
      if (selected === undefined) {
        showError(`No scenario is selected for the ${group} group.`)
        return
      }
      const frames = Number(frameInput.value)
      if (!Number.isSafeInteger(frames) || frames < 1) {
        showError('Frame count must be a positive integer.')
        return
      }

      busy = true
      syncControls()
      errorOutput.textContent = ''
      errorOutput.hidden = true
      clients.replaceChildren()
      authority.replaceChildren()
      verdict.textContent = ''
      verdict.removeAttribute('data-status')
      scenarioHeading.textContent = `${selected.scenario.title} · ${selected.scenario.id}`
      runStatus.textContent = `Running ${selected.scenario.id}…`

      try {
        context.setScenario(selected.scenario)
        const runtime = await createScenarioRuntime(selected.scenario, {
          fault: faultFor(context.state.fault),
          frame: 0,
          seed: context.state.seed,
        })
        const scenarioResult = await runtime.run(frames)
        if (disposed) {
          return
        }
        context.setState({ frame: scenarioResult.frame, play: 0 })
        context.setRuntime(runtime)
        renderResult(scenarioResult)
      } catch (error) {
        if (!disposed) {
          showError(`Scenario run failed for ${selected.scenario.id}: ${errorMessage(error)}`)
          runStatus.textContent = `Scenario ${selected.scenario.id} failed to run.`
        }
      } finally {
        busy = false
        syncControls()
      }
    }

    for (let index = 0; index < SCENARIO_GROUPS.length; index += 1) {
      const group = SCENARIO_GROUPS[index]
      const button = runButtons[index]
      const select = selectors[index]
      const frameInput = frameInputs[index]
      if (group === undefined || button === undefined || select === undefined || frameInput === undefined) {
        continue
      }
      const listener = (): Promise<void> => handleRun(group, select, frameInput)
      button.addEventListener('click', listener)
      listeners.push(() => button.removeEventListener('click', listener))
    }

    return {
      update(nextContext) {
        const runtimeChanged = nextContext.runtime !== renderedRuntime
        const scenarioChanged = nextContext.scenario?.id !== renderedScenarioId
        context = nextContext
        renderedRuntime = nextContext.runtime
        renderedScenarioId = nextContext.scenario?.id
        if (scenarioChanged && nextContext.runtime === undefined) {
          scenarioHeading.textContent = nextContext.scenario?.title ?? 'No scenario has run yet.'
          angle.textContent = ''
          verdict.textContent = ''
          verdict.removeAttribute('data-status')
          clients.replaceChildren()
          authority.replaceChildren()
        }
        if (runtimeChanged && nextContext.runtime !== undefined) {
          renderRuntimeSnapshot()
        }
      },
      dispose() {
        disposed = true
        for (const removeListener of listeners) {
          removeListener()
        }
      },
    }
  },
}

export default panel
