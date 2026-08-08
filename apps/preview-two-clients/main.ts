/**
 * `apps/preview-two-clients` — the built-in local two-client session.
 *
 * plan.md §3.14 confines this repository to transport and protocol and asks for
 * 「プロトコルのユニットテスト + ループバック同期テスト」; plan.md §6 Step 2 makes
 * the completion criterion tests green AND a built-in preview operable. This is
 * the second half. plan.md §4.1 requires it to live with the thing it verifies,
 * so it is a dev application INSIDE mx-multiplayer: not a package, not part of
 * `index.ts`, and not something a consumer can import.
 *
 * ---------------------------------------------------------------------------
 * What it is
 * ---------------------------------------------------------------------------
 *
 * Two peers in one process, wired to each other by `makeLoopbackPair`, running a
 * scripted handshake one step per keystroke. Every frame goes through the real
 * codec and crosses the transport as TEXT; every state comes out of the real
 * `transition`. The app supplies exactly two things the repository deliberately
 * does not have — a session script and a fault injector — and nothing else.
 *
 * ---------------------------------------------------------------------------
 * The interesting part is the fault injection
 * ---------------------------------------------------------------------------
 *
 * A clean handshake is worth one screenshot. What is worth an application is the
 * set of paths that are hard to reach in a test and impossible to reach by hand
 * against a real peer: drop a frame, corrupt one, forge a frame from a protocol
 * version this build does not speak, kill the transport in the middle of a
 * handshake, ask for a second connect while one is already in flight. Those are
 * the paths DN-1, DN-2 and DN-8 are about, and DN-8's own summary of why they
 * matter is that the bug they produce "只不安定な回線でしか再現しないため、
 * テストに乗らない".
 *
 * `--stats` runs all of them and reports what it measured. The first run found
 * four things; see README.md.
 *
 * ---------------------------------------------------------------------------
 * Why this renders in a terminal
 * ---------------------------------------------------------------------------
 *
 *  1. There is nothing to draw. This repository owns a wire format, a codec and
 *     a state machine. Every fact a person needs from it is a row: who sent
 *     what, at which version, how many bytes, and what the far end said about
 *     it. A camera adds nothing and removes the ability to see the whole session
 *     at once.
 *  2. Nothing is published yet (plan.md §6 Step 3 is bottom-up
 *     publish-then-pin), so `mc-playground-kit` cannot be taken as a
 *     devDependency. A preview that cannot be run is not a completion criterion,
 *     it is a plan to have one.
 *  3. `tsconfig.base.json` compiles this repository with `lib: ["ES2024"]` and
 *     `types: []` — DN-4's mechanical guarantee that the protocol layer cannot
 *     quietly acquire a platform dependency. A browser preview would need "DOM"
 *     back in some tsconfig and would convert that guarantee into a promise.
 *
 * mx-worldgen's terrain preview made this argument first, mx-redstone's circuit
 * board sharpened it, and it applies here more strongly than to either: a
 * protocol has no silhouette at all.
 *
 * ---------------------------------------------------------------------------
 * Constraints this app is written under
 * ---------------------------------------------------------------------------
 *
 *  - `apps` is in `SCAN_ROOTS` (`scripts/check-dependency-whitelist.ts:238`), so
 *    the preview's imports are gated like any other source here. It imports this
 *    repository's own modules and `effect`, and nothing else — no org package,
 *    no new npm dependency, not even a colour library.
 *  - The `Date.now()` / `new Date()` / `performance.now()` ban applies, and here
 *    it is not merely satisfied, it is the point. DN-3 removed the wall clock
 *    from the protocol; a preview that measured round-trip time with `Date.now()`
 *    would put it back in the one place that is supposed to prove it is gone.
 *    `Ping`/`Pong` match on a NONCE. `mc-kernel-allow-time-source` is not taken.
 *  - `pnpm verify` does not run this app. `tsconfig.preview.json` typechecks it
 *    and `pnpm lint` lints it; `pnpm preview` is not a gate.
 */
import { Effect } from 'effect'
import { ANSI_STYLE, PLAIN_STYLE, type Style } from './ansi'
import { HUD_ROWS, type HudState, buildHelp, buildHud } from './hud'
import { type PreviewOptions, USAGE, parseArguments } from './options'
import {
  VIEW_MODES,
  type ViewMode,
  renderFaults,
  renderMachine,
  renderWire,
  stepBanner,
} from './render'
import { buildStatsReport } from './stats'
import {
  MACHINE_FAULTS,
  SCRIPT,
  type Session,
  WIRE_FAULTS,
  type WireFault,
  advance,
  makeSession,
  runScript,
} from './session'
import {
  enterFullScreen,
  guardBrokenPipe,
  isInteractive,
  leaveFullScreen,
  onExit,
  onInputEnd,
  onKey,
  onResize,
  paintFrame,
  screenSize,
  writeLine,
} from './terminal'

type State = {
  session: Session
  view: ViewMode
  showText: boolean
  showHelp: boolean
}

const frameSize = (options: PreviewOptions): { readonly columns: number; readonly rows: number } => {
  const screen = screenSize()
  return {
    columns: Math.max(60, options.frameWidth ?? screen.columns),
    rows: Math.max(10, (options.frameHeight ?? screen.rows) - HUD_ROWS - 4),
  }
}

const render = (state: State, options: PreviewOptions, style: Style): ReadonlyArray<string> => {
  if (state.showHelp) {
    return buildHelp(style)
  }

  const frame = frameSize(options)
  const body =
    state.view === 'machine'
      ? renderMachine(state.session, style, frame.rows)
      : state.view === 'faults'
        ? renderFaults(state.session, style)
        : renderWire(state.session, style, frame.rows, state.showText)

  const hud: HudState = {
    showText: state.showText,
    view: state.view,
  }

  return [...stepBanner(state.session, style), '', ...body, '', ...buildHud(hud, state.session, style)]
}

const cycle = <A>(values: ReadonlyArray<A>, current: A, fallback: A): A =>
  values[(values.indexOf(current) + 1) % values.length] ?? fallback

/** Returns false when the key means "quit". */
const handleKey = (state: State, key: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (state.showHelp) {
      state.showHelp = false
      return true
    }

    const {session} = state

    switch (key) {
      case 'x':
      case 'escape':
      case 'ctrl-c':
        return false
      case '?':
        state.showHelp = true
        return true

      case ' ':
      case 'enter':
        yield* advance(session)
        return true
      case 's':
        yield* runScript(session)
        session.note = 'ran the rest of the script'
        return true
      case 'r':
        state.session = yield* makeSession
        return true

      case 'f': {
        const next: WireFault = cycle(WIRE_FAULTS, session.armed, 'none')
        session.armed = next
        session.note = next === 'none' ? 'no fault armed' : `armed: ${next} (applies to the NEXT frame)`
        return true
      }
      case 'F':
        session.armed = 'none'
        session.note = 'no fault armed'
        return true

      case 't':
        state.showText = !state.showText
        return true
      case 'v':
        state.view = cycle(VIEW_MODES, state.view, 'wire')
        return true

      default:
        break
    }

    const fault = MACHINE_FAULTS.find((entry) => entry.key === key)
    if (fault !== undefined) {
      yield* fault.run(session)
      session.note = fault.label
    }

    return true
  })

const runInteractive = (state: State, options: PreviewOptions, style: Style): void => {
  enterFullScreen()

  let restored = false
  const restore = (): void => {
    if (!restored) {
      restored = true
      leaveFullScreen()
    }
  }
  onExit(restore)

  const draw = (): void => {
    paintFrame(render(state, options, style))
  }

  const quit = (): void => {
    restore()
    process.exit(0)
  }

  onResize(draw)
  onInputEnd(quit)
  onKey((key) => {
    if (Effect.runSync(handleKey(state, key))) {
      draw()
      return
    }
    quit()
  })

  draw()
}

const SCRIPT_LIST: ReadonlyArray<string> = SCRIPT.flatMap((step, index) => [
  `  ${String(index + 1).padStart(2, ' ')}  ${step.label}`,
  `      · ${step.watch}`,
])

const program: Effect.Effect<number> = Effect.gen(function* () {
  guardBrokenPipe()

  const options = parseArguments(process.argv.slice(2))
  const style = options.ascii ? PLAIN_STYLE : ANSI_STYLE

  if (options.errors.length > 0) {
    for (const error of options.errors) {
      writeLine(`preview-two-clients: ${error}`)
    }
    writeLine('')
    for (const line of USAGE) {
      writeLine(line)
    }
    return 1
  }

  if (options.help) {
    for (const line of USAGE) {
      writeLine(line)
    }
    return 0
  }

  if (options.list) {
    writeLine('the handshake script')
    writeLine('')
    for (const line of SCRIPT_LIST) {
      writeLine(line)
    }
    return 0
  }

  if (options.stats) {
    for (const line of yield* buildStatsReport) {
      writeLine(line)
    }
    return 0
  }

  const state: State = {
    session: yield* makeSession,
    showHelp: false,
    showText: options.frames,
    view: options.view,
  }

  // Advance to the step the fault is armed at, arm it, then carry on. That is
  // What "kill the transport MID-handshake" means: the fault has to land between
  // Two steps, not before the session starts.
  const target = options.script ? SCRIPT.length : options.steps
  while (state.session.step < target) {
    if (state.session.step === options.faultAt && options.fault !== 'none') {
      state.session.armed = options.fault
    }
    yield* advance(state.session)
  }
  if (state.session.step === options.faultAt && options.fault !== 'none') {
    state.session.armed = options.fault
  }

  if (options.once || !isInteractive()) {
    if (!options.once) {
      writeLine(
        style.dim('preview-two-clients: stdin/stdout is not a TTY, drawing a single frame (same as --once)'),
      )
    }
    for (const line of render(state, options, style)) {
      writeLine(line)
    }
    return 0
  }

  runInteractive(state, options, style)
  return 0
})

const exitCode = Effect.runSync(program)
if (exitCode !== 0) {
  process.exit(exitCode)
}
