import { Schema } from 'effect'
import { getScenarioById } from '../../../scenarios/index.js'
import { createScenarioRuntime } from '../../../scenarios/runtime.js'
import {
  SCENARIO_SPEEDS,
  type ScenarioDefinition,
  type ScenarioFault,
  type ScenarioFaultKind,
  type ScenarioResult,
  type ScenarioRuntime,
  type ScenarioRuntimeOptions,
  type ScenarioUrlState,
} from '../../../scenarios/types.js'
import type { DebugPanel, DebugPanelContext } from './types.js'

const MAX_REPRODUCTION_JSON_LENGTH = 4096
const FIRST_DELAY_FRAME = 1
const ZERO = 0
const ONE = 1

const ScenarioFaultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('none') }),
  Schema.Struct({
    atFrame: Schema.optional(Schema.Natural),
    clientId: Schema.optional(Schema.Literals(['client-a', 'client-b'])),
    frames: Schema.Natural.check(Schema.isGreaterThanOrEqualTo(FIRST_DELAY_FRAME)),
    kind: Schema.Literal('delay'),
  }),
  Schema.Struct({
    atFrame: Schema.optional(Schema.Natural),
    clientId: Schema.optional(Schema.Literals(['client-a', 'client-b'])),
    kind: Schema.Literal('drop'),
  }),
  Schema.Struct({ atFrame: Schema.optional(Schema.Natural), kind: Schema.Literal('reorder') }),
  Schema.Struct({
    atFrame: Schema.optional(Schema.Natural),
    clientId: Schema.optional(Schema.Literals(['client-a', 'client-b'])),
    kind: Schema.Literal('disconnect'),
  }),
])

const ReproductionSchema = Schema.Struct({
  fault: ScenarioFaultSchema,
  frame: Schema.Natural,
  panel: Schema.optional(Schema.Literals([0, 1])),
  scenarioId: Schema.NonEmptyString,
  seed: Schema.Natural,
  speed: Schema.optional(Schema.Literals(SCENARIO_SPEEDS)),
})

type DecodedScenarioFault = Schema.Schema.Type<typeof ScenarioFaultSchema>
type Reproduction = Schema.Schema.Type<typeof ReproductionSchema>
type ReproductionDecodeResult =
  | { readonly _tag: 'InvalidJson' }
  | { readonly _tag: 'InvalidSchema' }
  | { readonly _tag: 'Success'; readonly value: Reproduction }

const decodeReproduction = (text: string): ReproductionDecodeResult => {
  try {
    const payload: unknown = JSON.parse(text)
    try {
      return {
        _tag: 'Success',
        value: Schema.decodeUnknownSync(ReproductionSchema, { onExcessProperty: 'error' })(payload),
      }
    } catch {
      return { _tag: 'InvalidSchema' }
    }
  } catch {
    return { _tag: 'InvalidJson' }
  }
}

const makeButton = (label: string): HTMLButtonElement => {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  return button
}

const setText = (element: HTMLElement, text: string): void => {
  if (element.textContent !== text) {
    element.textContent = text
  }
}

const faultForKind = (kind: ScenarioFaultKind): ScenarioFault => {
  switch (kind) {
    case 'none':
      return { kind: 'none' }
    case 'delay':
      return { kind: 'delay', frames: FIRST_DELAY_FRAME }
    case 'drop':
      return { kind: 'drop' }
    case 'reorder':
      return { kind: 'reorder' }
    case 'disconnect':
      return { kind: 'disconnect' }
  }
}

const faultKindFrom = (fault: ScenarioFault): ScenarioFaultKind => fault.kind

const scenarioFaultFrom = (fault: DecodedScenarioFault): ScenarioFault => {
  switch (fault.kind) {
    case 'none':
      return { kind: 'none' }
    case 'delay': {
      const atFrame = fault.atFrame
      const clientId = fault.clientId
      return {
        ...(atFrame === undefined ? {} : { atFrame }),
        ...(clientId === undefined ? {} : { clientId }),
        frames: fault.frames,
        kind: 'delay',
      }
    }
    case 'drop': {
      const atFrame = fault.atFrame
      const clientId = fault.clientId
      return {
        ...(atFrame === undefined ? {} : { atFrame }),
        ...(clientId === undefined ? {} : { clientId }),
        kind: 'drop',
      }
    }
    case 'reorder': {
      const atFrame = fault.atFrame
      return {
        ...(atFrame === undefined ? {} : { atFrame }),
        kind: 'reorder',
      }
    }
    case 'disconnect': {
      const atFrame = fault.atFrame
      const clientId = fault.clientId
      return {
        ...(atFrame === undefined ? {} : { atFrame }),
        ...(clientId === undefined ? {} : { clientId }),
        kind: 'disconnect',
      }
    }
  }
}

const timelinePanel: DebugPanel = {
  id: 'timeline',
  title: 'Timeline and reproduction',
  mount: (target, initialContext) => {
    const controls = document.createElement('div')
    const status = document.createElement('p')
    status.dataset['testid'] = 'timeline-status'
    const frameLabel = document.createElement('label')
    frameLabel.textContent = 'Seek to frame'
    const seekInput = document.createElement('input')
    seekInput.type = 'number'
    seekInput.min = String(ZERO)
    seekInput.step = String(ONE)
    seekInput.setAttribute('aria-label', 'Seek to frame')
    frameLabel.append(seekInput)

    const speedLabel = document.createElement('label')
    speedLabel.textContent = 'Timeline speed'
    const speedSelect = document.createElement('select')
    speedSelect.setAttribute('aria-label', 'Timeline speed')
    for (const speed of SCENARIO_SPEEDS) {
      const option = document.createElement('option')
      option.value = String(speed)
      option.textContent = String(speed) + '×'
      speedSelect.append(option)
    }
    speedLabel.append(speedSelect)

    const pauseButton = makeButton('Pause')
    const stepButton = makeButton('Step one frame')
    const playButton = makeButton('Play')
    const resetButton = makeButton('Reset')
    const seekButton = makeButton('Seek')
    const exportButton = makeButton('Export reproduction JSON')
    const importButton = makeButton('Import reproduction JSON')

    const reproductionLabel = document.createElement('label')
    reproductionLabel.textContent = 'Reproduction JSON'
    const reproductionInput = document.createElement('textarea')
    reproductionInput.setAttribute('aria-label', 'Reproduction JSON')
    reproductionLabel.append(reproductionInput)

    const error = document.createElement('p')
    error.setAttribute('role', 'alert')
    error.dataset['testid'] = 'timeline-import-error'
    error.hidden = true

    const frameOutput = document.createElement('output')
    frameOutput.dataset['testid'] = 'timeline-frame'
    frameOutput.textContent = String(initialContext.state.frame)

    const resultOutput = document.createElement('pre')
    resultOutput.dataset['testid'] = 'timeline-result'

    controls.append(
      pauseButton,
      stepButton,
      playButton,
      speedLabel,
      resetButton,
      frameLabel,
      seekButton,
      exportButton,
      importButton,
      reproductionLabel,
    )
    target.append(controls, status, error, frameOutput, resultOutput)

    let context = initialContext
    let runtime = context.runtime
    let disposed = false
    let suppressReconciliation = false
    let actionBusy = false
    let pending = Promise.resolve()
    let lastScenario = context.state.scenario
    let lastFrame = context.state.frame
    let lastSeed = context.state.seed
    let lastFaultKind = context.state.fault
    let lastSpeed = context.state.speed
    let lastPanel = context.state.panel
    let lastPlay = context.state.play
    const cleanups: Array<() => void> = []

    const setError = (message: string): void => {
      setText(error, message)
      error.hidden = message.length === ZERO
    }

    const rememberState = (state: ScenarioUrlState): void => {
      lastScenario = state.scenario
      lastFrame = state.frame
      lastSeed = state.seed
      lastFaultKind = state.fault
      lastSpeed = state.speed
      lastPanel = state.panel
      lastPlay = state.play
    }

    const renderResult = (result: ScenarioResult | undefined): void => {
      if (result === undefined) {
        frameOutput.textContent = ''
        resultOutput.textContent = ''
        return
      }
      setText(frameOutput, String(result.frame))
      setText(resultOutput, JSON.stringify(result, null, 2))
      seekInput.value = String(result.frame)
      speedSelect.value = String(result.speed)
    }

    const renderControls = (): void => {
      const hasRuntime = runtime !== undefined
      pauseButton.disabled = !hasRuntime
      stepButton.disabled = !hasRuntime || actionBusy
      playButton.disabled = !hasRuntime || actionBusy
      resetButton.disabled = !hasRuntime || actionBusy
      seekButton.disabled = !hasRuntime || actionBusy
      speedSelect.disabled = !hasRuntime || actionBusy
      exportButton.disabled = !hasRuntime || actionBusy
      importButton.disabled = actionBusy
    }

    const render = (): void => {
      const current = runtime?.snapshot()
      if (current === undefined) {
        setText(status, 'No scenario runtime is selected. Choose a scenario in the URL or import a reproduction JSON.')
      } else {
        setText(status, current.id + ' · ' + current.verdict.status + ': ' + current.verdict.summary)
      }
      renderResult(current)
      renderControls()
    }

    const setHostState = (patch: Partial<ScenarioUrlState>): void => {
      suppressReconciliation = true
      context.setState(patch)
      rememberState(context.state)
      suppressReconciliation = false
      render()
    }

    const enqueue = (operation: () => Promise<void>): void => {
      pending = pending.then(async () => {
        if (!disposed) {
          await operation()
        }
      }).catch(() => {
        if (!disposed) {
          runtime?.pause()
          setError('Runtime operation failed; playback was paused.')
          context.setState({ play: ZERO })
          render()
        }
      })
    }

    const optionsForState = (
      state: ScenarioUrlState,
      fault: ScenarioFault,
      frame: number,
      speed: ScenarioUrlState['speed'] = state.speed,
      panel: ScenarioUrlState['panel'] = state.panel,
    ): ScenarioRuntimeOptions => ({
      fault,
      frame,
      panel,
      play: false,
      seed: state.seed,
      speed,
    })

    const synchronizeRuntime = async (activeRuntime: ScenarioRuntime, state: ScenarioUrlState): Promise<void> => {
      if (disposed || runtime !== activeRuntime) {
        return
      }
      if (state.play === ONE) {
        activeRuntime.play()
      } else {
        activeRuntime.pause()
      }
      const before = activeRuntime.snapshot()
      if (before.speed !== state.speed) {
        activeRuntime.setSpeed(state.speed)
      }
      const fault = before.fault.kind === state.fault ? before.fault : faultForKind(state.fault)
      const configurationChanged = before.seed !== state.seed
        || before.fault.kind !== state.fault
        || before.panel !== state.panel
      const frameDelta = state.frame - before.frame
      if (configurationChanged || frameDelta < ZERO || frameDelta > ONE) {
        const result = await activeRuntime.reset(optionsForState(state, fault, state.frame))
        renderResult(result)
        return
      }
      if (frameDelta === ONE) {
        const result = await activeRuntime.step()
        renderResult(result)
        return
      }
      renderResult(activeRuntime.snapshot())
    }

    const attachRuntime = async (
      definition: ScenarioDefinition,
      state: ScenarioUrlState,
      options: ScenarioRuntimeOptions,
      shouldPlay: boolean,
    ): Promise<void> => {
      const nextRuntime = await createScenarioRuntime(definition, options)
      if (disposed) {
        return
      }
      suppressReconciliation = true
      if (context.scenario?.id !== definition.id) {
        context.setScenario(definition)
      }
      context.setRuntime(nextRuntime)
      runtime = nextRuntime
      if (shouldPlay) {
        nextRuntime.play()
      } else {
        nextRuntime.pause()
      }
      context.setState({
        fault: faultKindFrom(options.fault ?? faultForKind(state.fault)),
        frame: options.frame ?? state.frame,
        panel: options.panel ?? state.panel,
        play: shouldPlay ? ONE : ZERO,
        scenario: definition.id,
        seed: options.seed,
        speed: options.speed ?? state.speed,
      })
      rememberState(context.state)
      suppressReconciliation = false
      setError('')
      render()
    }

    const startFromState = async (state: ScenarioUrlState): Promise<void> => {
      if (state.scenario.length === ZERO) {
        render()
        return
      }
      const entry = getScenarioById(state.scenario)
      if (entry === undefined) {
        setText(status, 'Unknown scenario ID: ' + state.scenario)
        return
      }
      const stateToRestore: ScenarioUrlState = { ...state, play: ZERO }
      if (state.play === ONE) {
        context.setState({ play: ZERO })
      }
      await attachRuntime(
        entry.scenario,
        stateToRestore,
        optionsForState(stateToRestore, faultForKind(state.fault), state.frame),
        state.play === ONE,
      )
    }

    const withBusyAction = async (operation: () => Promise<void>): Promise<void> => {
      if (actionBusy || disposed) {
        return
      }
      actionBusy = true
      renderControls()
      try {
        await operation()
      } catch {
        if (!disposed) {
          setError('Runtime operation failed; the reproduction was not applied.')
        }
      } finally {
        actionBusy = false
        render()
      }
    }

    const setListener = (element: HTMLElement, type: string, listener: EventListener): void => {
      element.addEventListener(type, listener)
      cleanups.push(() => element.removeEventListener(type, listener))
    }

    const onClick = (button: HTMLButtonElement, operation: () => Promise<void> | void): void => {
      const listener: EventListener = async () => {
        try {
          await operation()
        } catch {
          if (!disposed) {
            setError('Timeline action failed.')
          }
        }
      }
      setListener(button, 'click', listener)
    }

    onClick(pauseButton, () => {
      runtime?.pause()
      context.setState({ play: ZERO })
    })

    onClick(playButton, () => {
      runtime?.play()
      context.setState({ play: ONE })
    })

    onClick(stepButton, () => withBusyAction(async () => {
      context.setState({ play: ZERO })
      await pending
      const activeRuntime = runtime
      if (activeRuntime === undefined) {
        return
      }
      const result = await activeRuntime.step()
      activeRuntime.pause()
      setHostState({ frame: result.frame, play: ZERO })
      setError('')
    }))

    onClick(resetButton, () => withBusyAction(async () => {
      context.setState({ play: ZERO })
      await pending
      const activeRuntime = runtime
      if (activeRuntime === undefined) {
        return
      }
      const current = activeRuntime.snapshot()
      const result = await activeRuntime.reset(optionsForState(
        context.state,
        current.fault,
        ZERO,
        SCENARIO_SPEEDS[2],
        context.state.panel,
      ))
      setHostState({ frame: ZERO, play: ZERO, speed: result.speed })
      setError('')
    }))

    onClick(seekButton, () => withBusyAction(async () => {
      const rawFrame = seekInput.value.trim()
      const frame = Number(rawFrame)
      if (rawFrame.length === ZERO || !Number.isSafeInteger(frame) || frame < ZERO) {
        setError('Rejected: seek frame must be a non-negative safe integer.')
        return
      }
      context.setState({ play: ZERO })
      await pending
      const activeRuntime = runtime
      if (activeRuntime === undefined) {
        return
      }
      const current = activeRuntime.snapshot()
      const result = await activeRuntime.reset(optionsForState(
        context.state,
        current.fault.kind === context.state.fault ? current.fault : faultForKind(context.state.fault),
        frame,
      ))
      setHostState({ frame, play: ZERO })
      setError('')
      renderResult(result)
    }))

    speedSelect.value = String(context.state.speed)
    const speedListener: EventListener = () => {
      const speed = SCENARIO_SPEEDS.find((candidate) => String(candidate) === speedSelect.value)
      if (speed === undefined) {
        return
      }
      runtime?.setSpeed(speed)
      context.setState({ speed })
      setError('')
    }
    setListener(speedSelect, 'change', speedListener)

    onClick(exportButton, () => withBusyAction(async () => {
      context.setState({ play: ZERO })
      await pending
      const current = runtime?.snapshot()
      if (current === undefined) {
        return
      }
      const reproduction = {
        fault: current.fault,
        frame: current.frame,
        panel: current.panel,
        scenarioId: current.id,
        seed: current.seed,
        speed: current.speed,
      }
      reproductionInput.value = JSON.stringify(reproduction, null, 2)
      setHostState({ frame: current.frame, play: ZERO, speed: current.speed })
      setError('')
      renderResult(runtime?.snapshot())
    }))

    onClick(importButton, () => withBusyAction(async () => {
      setError('')
      if (reproductionInput.value.length > MAX_REPRODUCTION_JSON_LENGTH) {
        setError('Rejected: reproduction JSON exceeds ' + String(MAX_REPRODUCTION_JSON_LENGTH) + ' characters.')
        return
      }
      const decoded = decodeReproduction(reproductionInput.value)
      if (decoded._tag === 'InvalidJson') {
        setError('Rejected: reproduction JSON is not valid JSON.')
        return
      }
      if (decoded._tag === 'InvalidSchema') {
        setError('Rejected: reproduction JSON fields do not match the required schema.')
        return
      }
      const reproduction = decoded.value
      const entry = getScenarioById(reproduction.scenarioId)
      if (entry === undefined) {
        setError('Rejected: unknown scenario ID "' + reproduction.scenarioId + '".')
        return
      }

      context.setState({ play: ZERO })
      await pending
      const speed = reproduction.speed ?? context.state.speed
      const panel = reproduction.panel ?? context.state.panel
      const fault = scenarioFaultFrom(reproduction.fault)
      const options: ScenarioRuntimeOptions = {
        fault,
        frame: reproduction.frame,
        panel,
        play: false,
        seed: reproduction.seed,
        speed,
      }
      const currentRuntime = runtime
      if (currentRuntime !== undefined && currentRuntime.snapshot().id === reproduction.scenarioId) {
        const result = await currentRuntime.reset(options)
        setHostState({
          fault: faultKindFrom(fault),
          frame: reproduction.frame,
          panel,
          play: ZERO,
          scenario: reproduction.scenarioId,
          seed: reproduction.seed,
          speed,
        })
        renderResult(result)
      } else {
        await attachRuntime(
          entry.scenario,
          context.state,
          options,
          false,
        )
      }
      setError('')
    }))

    render()
    if (runtime === undefined && context.scenario === undefined) {
      startFromState(initialContext.state).catch(() => {
        if (!disposed) {
          setError('Runtime initialization failed.')
        }
      })
    }

    return {
      update: (nextContext: DebugPanelContext) => {
        const previousScenario = lastScenario
        const previousRuntime = runtime
        context = nextContext
        runtime = nextContext.runtime
        if (suppressReconciliation) {
          rememberState(nextContext.state)
          render()
          return
        }
        const stateChanged = nextContext.state.frame !== lastFrame
          || nextContext.state.seed !== lastSeed
          || nextContext.state.fault !== lastFaultKind
          || nextContext.state.speed !== lastSpeed
          || nextContext.state.panel !== lastPanel
          || nextContext.state.play !== lastPlay
        const scenarioChanged = nextContext.state.scenario !== previousScenario
        rememberState(nextContext.state)
        if (runtime !== undefined) {
          if (nextContext.state.play === ONE) {
            runtime.play()
          } else {
            runtime.pause()
          }
          if (runtime.snapshot().speed !== nextContext.state.speed) {
            runtime.setSpeed(nextContext.state.speed)
          }
          if (stateChanged || previousRuntime !== runtime) {
            const activeRuntime = runtime
            const state = nextContext.state
            enqueue(() => synchronizeRuntime(activeRuntime, state))
          }
        } else if (scenarioChanged && nextContext.scenario === undefined && nextContext.state.scenario.length > ZERO) {
          const state = nextContext.state
          const entry = getScenarioById(state.scenario)
          if (entry !== undefined) {
            startFromState(state).catch(() => {
              if (!disposed) {
                setError('Runtime initialization failed.')
              }
            })
          }
        }
        render()
      },
      dispose: () => {
        disposed = true
        for (const cleanup of cleanups) {
          cleanup()
        }
        cleanups.length = ZERO
      },
    }
  },
}

export default timelinePanel
