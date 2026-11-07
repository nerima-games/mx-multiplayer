import './styles.css'
import {
  SCENARIO_FAULT_KINDS,
  SCENARIO_SPEEDS,
  type ScenarioDefinition,
  type ScenarioRuntime,
  type ScenarioUrlState,
} from '../../scenarios/types.js'
import type { DebugPanel, DebugPanelContext, DebugPanelHandle } from './panels/types.js'

const DEFAULT_URL_STATE: ScenarioUrlState = {
  scenario: '',
  play: 0,
  speed: 1,
  panel: 0,
  seed: 0,
  fault: 'none',
  frame: 0,
}
const CLOCK_FRAMES_PER_SECOND = 60
const app = document.querySelector<HTMLDivElement>('#app')

if (app === null) {
  throw new Error('Debug UI root element was not found')
}

type UrlIssue = {
  readonly key: keyof ScenarioUrlState
  readonly replacement: string
}

type PanelModule = {
  readonly default?: DebugPanel
}

const formatValue = (value: string | number): string =>
  typeof value === 'string' ? JSON.stringify(value) : String(value)

const readParameter = <Value extends string | number>(
  params: URLSearchParams,
  key: keyof ScenarioUrlState,
  fallback: Value,
  parse: (raw: string) => Value | undefined,
  issues: UrlIssue[],
): Value => {
  const values = params.getAll(key)
  if (values.length === 0) {
    return fallback
  }

  const raw = values.length === 1 ? values[0] : undefined
  const parsed = raw === undefined ? undefined : parse(raw)
  if (parsed !== undefined) {
    return parsed
  }

  issues.push({ key, replacement: formatValue(fallback) })
  return fallback
}

const parseBinaryState = (raw: string): ScenarioUrlState['play'] | undefined => {
  if (raw === '0') {
    return 0
  }
  if (raw === '1') {
    return 1
  }
  return undefined
}

const parseNonNegativeInteger = (raw: string): number | undefined => {
  if (raw.trim() === '') {
    return undefined
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

const parseUrlState = (search: string): { state: ScenarioUrlState; issues: UrlIssue[] } => {
  const params = new URLSearchParams(search)
  const issues: UrlIssue[] = []
  const state: ScenarioUrlState = {
    scenario: readParameter(params, 'scenario', DEFAULT_URL_STATE.scenario, (raw) =>
      raw.trim() === '' || raw.trim() !== raw ? undefined : raw, issues),
    play: readParameter(params, 'play', DEFAULT_URL_STATE.play, parseBinaryState, issues),
    speed: readParameter(params, 'speed', DEFAULT_URL_STATE.speed, (raw) =>
      SCENARIO_SPEEDS.find((speed) => String(speed) === raw), issues),
    panel: readParameter(params, 'panel', DEFAULT_URL_STATE.panel, parseBinaryState, issues),
    seed: readParameter(params, 'seed', DEFAULT_URL_STATE.seed, parseNonNegativeInteger, issues),
    fault: readParameter(params, 'fault', DEFAULT_URL_STATE.fault, (raw) =>
      SCENARIO_FAULT_KINDS.find((fault) => fault === raw), issues),
    frame: readParameter(params, 'frame', DEFAULT_URL_STATE.frame, parseNonNegativeInteger, issues),
  }

  return { state, issues }
}

const writeUrlState = (state: ScenarioUrlState): void => {
  const url = new URL(window.location.href)
  url.searchParams.set('scenario', state.scenario)
  url.searchParams.set('play', String(state.play))
  url.searchParams.set('speed', String(state.speed))
  url.searchParams.set('panel', String(state.panel))
  url.searchParams.set('seed', String(state.seed))
  url.searchParams.set('fault', state.fault)
  url.searchParams.set('frame', String(state.frame))
  window.history.replaceState(window.history.state, '', url)
}

class DebugUiHost {
  #state: ScenarioUrlState
  #issues: UrlIssue[]
  #scenario: ScenarioDefinition | undefined = undefined
  #runtime: ScenarioRuntime | undefined = undefined
  #animationFrame: number | undefined = undefined
  #lastFrameTime: number | undefined = undefined
  #panelHandles: DebugPanelHandle[] = []
  #alertRegion: HTMLDivElement
  #controls: HTMLElement
  #stateOutput: HTMLElement
  #panelGrid: HTMLDivElement
  #pauseButton: HTMLButtonElement
  #stepButton: HTMLButtonElement
  #playButton: HTMLButtonElement
  #speedButton: HTMLButtonElement
  #speedReadout: HTMLOutputElement
  #resetButton: HTMLButtonElement
  #panels: DebugPanel[]

  constructor(root: HTMLElement, search: string) {
    const parsed = parseUrlState(search)
    this.#state = parsed.state
    this.#issues = parsed.issues
    if (this.#issues.length > 0) {
      writeUrlState(this.#state)
    }

    root.innerHTML = `
      <header>
        <h1>mx-multiplayer debug UI</h1>
        <p class="intro">Deterministic scenarios for two-client multiplayer behavior.</p>
      </header>
      <div class="url-alert" role="alert" aria-label="Invalid URL values" hidden></div>
      <nav class="control-bar" aria-label="Simulation controls"></nav>
      <section class="state-section" aria-labelledby="state-heading">
        <h2 id="state-heading">URL state</h2>
        <pre class="url-state" data-testid="url-state"></pre>
      </section>
      <section class="panel-section" aria-labelledby="panel-heading">
        <h2 id="panel-heading">Debug panels</h2>
        <div class="panel-grid" data-testid="panel-grid"></div>
      </section>
    `

    const alertRegion = root.querySelector<HTMLDivElement>('[role="alert"]')
    const controls = root.querySelector<HTMLElement>('.control-bar')
    const stateOutput = root.querySelector<HTMLElement>('[data-testid="url-state"]')
    const panelGrid = root.querySelector<HTMLDivElement>('[data-testid="panel-grid"]')
    if (alertRegion === null || controls === null || stateOutput === null || panelGrid === null) {
      throw new Error('Debug UI shell elements are incomplete')
    }
    this.#alertRegion = alertRegion
    this.#controls = controls
    this.#stateOutput = stateOutput
    this.#panelGrid = panelGrid

    const panelModules = import.meta.glob<PanelModule>('./panels/*.ts', { eager: true })
    this.#panels = Object.values(panelModules)
      .flatMap((module) => (module.default === undefined ? [] : [module.default]))
      .sort((left, right) => left.id.localeCompare(right.id, 'en'))
    if (new Set(this.#panels.map((panel) => panel.id)).size !== this.#panels.length) {
      throw new Error('Debug panel IDs must be unique')
    }

    this.#pauseButton = DebugUiHost.#makeButton('Pause', () => this.#updateState({ play: 0 }))
    this.#stepButton = DebugUiHost.#makeButton('Step frame', () => {
      const frame = this.#state.frame + 1
      this.#updateState({ play: 0, frame: Number.isSafeInteger(frame) ? frame : this.#state.frame })
    })
    this.#playButton = DebugUiHost.#makeButton('Play', () => this.#updateState({ play: 1 }))
    this.#speedButton = DebugUiHost.#makeButton('Speed', () => {
      const nextIndex = (SCENARIO_SPEEDS.indexOf(this.#state.speed) + 1) % SCENARIO_SPEEDS.length
      const nextSpeed = SCENARIO_SPEEDS[nextIndex]
      if (nextSpeed !== undefined) {
        this.#updateState({ speed: nextSpeed })
      }
    })
    this.#speedReadout = document.createElement('output')
    this.#speedReadout.className = 'speed-readout'
    this.#speedReadout.setAttribute('aria-label', 'Current speed')
    this.#resetButton = DebugUiHost.#makeButton('Reset', () => this.#updateState({ play: 0, speed: 1, frame: 0 }))
    this.#controls.append(
      this.#pauseButton,
      this.#stepButton,
      this.#playButton,
      this.#speedButton,
      this.#speedReadout,
      this.#resetButton,
    )

    this.#mountPanels()
    window.addEventListener('popstate', () => this.#handlePopState())
    this.#render()
    if (this.#state.play === 1) {
      this.#startPlayback()
    }
    document.body.dataset['ready'] = 'true'
  }

  static #makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.addEventListener('click', onClick)
    return button
  }

  #makePanelContext(): DebugPanelContext {
    return {
      state: this.#state,
      scenario: this.#scenario,
      runtime: this.#runtime,
      setState: (patch) => this.#updateState(patch),
      setScenario: (scenario) => this.#setScenario(scenario),
      setRuntime: (runtime) => this.#setRuntime(runtime),
    }
  }

  #mountPanels(): void {
    for (const panel of this.#panels) {
      const section = document.createElement('section')
      section.className = 'panel-card'
      section.dataset['panelId'] = panel.id
      const heading = document.createElement('h3')
      heading.textContent = panel.title
      const target = document.createElement('div')
      section.append(heading, target)
      this.#panelGrid.append(section)
      this.#panelHandles.push(panel.mount(target, this.#makePanelContext()))
    }
    this.#updatePanels()
  }

  #updatePanels(): void {
    const context = this.#makePanelContext()
    for (const handle of this.#panelHandles) {
      handle.update(context)
    }
  }

  #renderState(): void {
    this.#stateOutput.textContent = JSON.stringify(this.#state, null, 2)
    this.#panelGrid.dataset['panel'] = String(this.#state.panel)
  }

  #renderControls(): void {
    this.#pauseButton.setAttribute('aria-pressed', String(this.#state.play === 0))
    this.#playButton.setAttribute('aria-pressed', String(this.#state.play === 1))
    this.#speedReadout.textContent = `${this.#state.speed}x`
  }

  #renderIssues(): void {
    this.#alertRegion.replaceChildren(
      ...this.#issues.map((issue) => {
        const message = document.createElement('p')
        message.textContent = `${issue.key}: using ${issue.replacement}`
        return message
      }),
    )
    this.#alertRegion.hidden = this.#issues.length === 0
  }

  #render(): void {
    this.#renderState()
    this.#renderControls()
    this.#renderIssues()
    this.#updatePanels()
  }

  #updateState(patch: Partial<ScenarioUrlState>): void {
    const wasPlaying = this.#state.play
    this.#state = { ...this.#state, ...patch }
    writeUrlState(this.#state)
    this.#renderState()
    this.#renderControls()
    this.#updatePanels()
    if (this.#state.play === 0 && wasPlaying === 1) {
      this.#stopPlayback()
    }
    if (this.#state.play === 1 && wasPlaying === 0) {
      this.#startPlayback()
    }
  }

  #setScenario(scenario: ScenarioDefinition | undefined): void {
    this.#scenario = scenario
    this.#runtime = undefined
    this.#updateState({ scenario: scenario?.id ?? '', play: 0, frame: 0 })
  }

  #setRuntime(runtime: ScenarioRuntime | undefined): void {
    this.#runtime = runtime
    this.#updatePanels()
  }

  #startPlayback(): void {
    if (this.#animationFrame === undefined) {
      this.#lastFrameTime = undefined
      this.#animationFrame = window.requestAnimationFrame((timestamp) => this.#advancePlayback(timestamp))
    }
  }

  #stopPlayback(): void {
    if (this.#animationFrame !== undefined) {
      window.cancelAnimationFrame(this.#animationFrame)
      this.#animationFrame = undefined
    }
    this.#lastFrameTime = undefined
  }

  #advancePlayback(timestamp: number): void {
    this.#animationFrame = undefined
    if (this.#state.play === 0) {
      return
    }
    if (this.#lastFrameTime === undefined) {
      this.#lastFrameTime = timestamp
    } else {
      const frameDuration = 1000 / (CLOCK_FRAMES_PER_SECOND * this.#state.speed)
      if (timestamp - this.#lastFrameTime >= frameDuration) {
        this.#lastFrameTime = timestamp
        const frame = this.#state.frame + 1
        this.#updateState({ play: Number.isSafeInteger(frame) ? 1 : 0, frame: Number.isSafeInteger(frame) ? frame : this.#state.frame })
      }
    }
    if (this.#state.play === 1) {
      this.#animationFrame = window.requestAnimationFrame((nextTimestamp) => this.#advancePlayback(nextTimestamp))
    }
  }

  #handlePopState(): void {
    const wasPlaying = this.#state.play
    const parsed = parseUrlState(window.location.search)
    this.#state = parsed.state
    this.#issues = parsed.issues
    if (this.#issues.length > 0) {
      writeUrlState(this.#state)
    }
    if (this.#scenario?.id !== this.#state.scenario) {
      this.#scenario = undefined
      this.#runtime = undefined
    }
    this.#render()
    if (wasPlaying === 1 && this.#state.play === 0) {
      this.#stopPlayback()
    }
    if (wasPlaying === 0 && this.#state.play === 1) {
      this.#startPlayback()
    }
  }

  dispose(): void {
    this.#stopPlayback()
    for (const handle of this.#panelHandles) {
      handle.dispose()
    }
  }
}

const host = new DebugUiHost(app, window.location.search)
window.addEventListener('pagehide', () => host.dispose())
