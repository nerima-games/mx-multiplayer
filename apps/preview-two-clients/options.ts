/**
 * Command-line options for the two-client preview.
 *
 * A dev application, not shipped API.
 *
 * Pure: `parseArguments` reads an array and returns a value. It never touches
 * `process`, so the whole option surface is exercisable without launching a
 * terminal UI — which matters because a parser that can only be tested by
 * starting a full-screen app is a parser nobody tests.
 *
 * Adapted from mx-gameplay's and mx-redstone's, including their two hard-won
 * behaviours: `--` is accepted and ignored (pnpm 9 forwards a literal one when
 * somebody writes `pnpm preview -- --stats` out of npm habit), and an unknown
 * flag is an ERROR rather than a silent no-op. A dropped `--fault` is a
 * transcript that shows a clean session with full confidence.
 */
import { VIEW_MODES, type ViewMode, isViewMode } from './render'
import { WIRE_FAULTS, type WireFault } from './session'

export type PreviewOptions = {
  readonly view: ViewMode
  /** Advance this many script steps before drawing. */
  readonly steps: number
  /** Run the whole handshake script before drawing. */
  readonly script: boolean
  /** Arm this wire fault before the first step. */
  readonly fault: WireFault
  /** Which step index the fault is armed at. Default 0 = immediately. */
  readonly faultAt: number
  /** Print the raw frame text under every wire row. */
  readonly frames: boolean
  readonly once: boolean
  readonly ascii: boolean
  readonly stats: boolean
  readonly list: boolean
  readonly help: boolean
  readonly frameWidth: number | undefined
  readonly frameHeight: number | undefined
  readonly errors: ReadonlyArray<string>
}

const DEFAULTS = {
  ascii: false,
  errors: [],
  fault: 'none',
  faultAt: 0,
  frameHeight: undefined,
  frameWidth: undefined,
  frames: false,
  help: false,
  list: false,
  once: false,
  script: false,
  stats: false,
  steps: 0,
  view: 'wire',
} satisfies PreviewOptions

type Accumulator = {
  -readonly [Key in keyof PreviewOptions]: PreviewOptions[Key]
}

const readNumber = (
  accumulator: Accumulator,
  flag: string,
  raw: string | undefined,
): number | undefined => {
  if (raw === undefined) {
    accumulator.errors = [...accumulator.errors, `${flag} needs a value`]
    return undefined
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    accumulator.errors = [...accumulator.errors, `${flag}: "${raw}" is not a number`]
    return undefined
  }
  return value
}

const isWireFault = (value: string): value is WireFault =>
  (WIRE_FAULTS as ReadonlyArray<string>).includes(value)

export const parseArguments = (argv: ReadonlyArray<string>): PreviewOptions => {
  const accumulator: Accumulator = { ...DEFAULTS }
  const queue = [...argv]

  while (queue.length > 0) {
    const token = queue.shift()
    if (token === undefined) {
      break
    }

    const equalsAt = token.indexOf('=')
    const flag = equalsAt === -1 ? token : token.slice(0, equalsAt)
    const inlineValue = equalsAt === -1 ? undefined : token.slice(equalsAt + 1)
    const takeValue = (): string | undefined => inlineValue ?? queue.shift()

    switch (flag) {
      case '--':
        break
      case '--help':
      case '-h':
        accumulator.help = true
        break
      case '--stats':
        accumulator.stats = true
        break
      case '--list':
        accumulator.list = true
        break
      case '--once':
        accumulator.once = true
        break
      case '--ascii':
        accumulator.ascii = true
        break
      case '--script':
        accumulator.script = true
        break
      case '--frames':
        accumulator.frames = true
        break
      case '--view': {
        const value = takeValue()
        if (value !== undefined && isViewMode(value)) {
          accumulator.view = value
        } else {
          accumulator.errors = [
            ...accumulator.errors,
            `--view: "${String(value)}" is not one of ${VIEW_MODES.join(', ')}`,
          ]
        }
        break
      }
      case '--fault': {
        const value = takeValue()
        if (value !== undefined && isWireFault(value)) {
          accumulator.fault = value
        } else {
          accumulator.errors = [
            ...accumulator.errors,
            `--fault: "${String(value)}" is not one of ${WIRE_FAULTS.join(', ')}`,
          ]
        }
        break
      }
      case '--fault-at':
        accumulator.faultAt = Math.max(0, readNumber(accumulator, flag, takeValue()) ?? accumulator.faultAt)
        break
      case '--steps':
        accumulator.steps = Math.max(0, readNumber(accumulator, flag, takeValue()) ?? accumulator.steps)
        break
      case '--width':
        accumulator.frameWidth = readNumber(accumulator, flag, takeValue()) ?? accumulator.frameWidth
        break
      case '--height':
        accumulator.frameHeight = readNumber(accumulator, flag, takeValue()) ?? accumulator.frameHeight
        break
      default:
        accumulator.errors = [...accumulator.errors, `unknown option: ${flag}`]
        break
    }
  }

  return {
    ...accumulator,
    faultAt: Math.trunc(accumulator.faultAt),
    steps: Math.trunc(accumulator.steps),
  }
}

export const USAGE: ReadonlyArray<string> = [
  'pnpm preview [options]        local two-client session for @nerima-games/mx-multiplayer',
  '',
  'options',
  '  --view <mode>       wire | machine | faults                 (default wire)',
  '  --script            run the whole handshake before drawing',
  '  --steps <n>         advance n script steps before drawing   (default 0)',
  `  --fault <name>      arm a wire fault: ${WIRE_FAULTS.join(', ')}`,
  '  --fault-at <n>      arm it just before script step n        (default 0)',
  '  --frames            print the raw frame text under every wire row',
  '  --list              print the script, step by step, and what each step is for',
  '  --once              render one frame to stdout and exit (no raw mode, pipe-safe)',
  '  --ascii             glyphs instead of colour — pasteable into an issue or a diff',
  '  --stats             print the measured report instead of a picture',
  '  --width <n> --height <n>   force the frame size in terminal cells',
  '  --help              this text',
  '',
  'keys (interactive)',
  '  space / enter   advance ONE script step        s  run the rest of the script',
  '  f               cycle the armed wire fault     F  clear it',
  '  a b c d e w z   machine faults (see the faults view)',
  '  t               toggle raw frame text in the wire view',
  '  v               cycle view: wire | machine | faults',
  '  r               reset the session               ?  help',
  '  x  Esc  Ctrl-C  quit',
]
