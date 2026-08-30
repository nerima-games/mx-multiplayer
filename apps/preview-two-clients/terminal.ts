/**
 * The only impure module in the preview.
 *
 * A dev application, not shipped API.
 *
 * Everything else here — the session, the fault injector, the renderer, the
 * option parser, the stats report — is either a pure function of its arguments
 * or an `Effect` over an explicit transport. Node's stdio lives behind this file
 * so the boundary is visible rather than sprinkled.
 *
 * Note what is NOT here: any read of a clock. The session advances one STEP in
 * response to a keystroke and never on a timer, so `Date.now()` /
 * `performance.now()` never come up and the escape hatch documented in
 * `scripts/check-dependency-whitelist.ts` (`mc-kernel-allow-time-source`) is not
 * taken. That is not a limitation being worked around, it is DN-3: this
 * repository removed the wall clock from the protocol on purpose, and a preview
 * that measured round trips against `Date.now()` would put it straight back in
 * the one place that is supposed to prove it is gone. `Ping`/`Pong` match on a
 * NONCE here, exactly as `domain/protocol.ts:154-165` says they must.
 *
 * Adapted from mx-gameplay's `apps/preview-mining-site/terminal.ts`, itself
 * adapted from mx-redstone's and mc-worldgen's. The copies are deliberate; see
 * `ansi.ts`.
 */
import { ESC } from './ansi'

export type Screen = {
  readonly columns: number
  readonly rows: number
}

const FALLBACK_SCREEN: Screen = { columns: 120, rows: 40 }

export const screenSize = (): Screen => ({
  columns: process.stdout.columns ?? FALLBACK_SCREEN.columns,
  rows: process.stdout.rows ?? FALLBACK_SCREEN.rows,
})

export const write = (text: string): void => {
  process.stdout.write(text)
}

export const NEWLINE: string = String.fromCharCode(10)

export const writeLine = (text = ''): void => {
  process.stdout.write(`${text}${NEWLINE}`)
}

/**
 * Exit quietly when the reader goes away.
 *
 * `pnpm preview --stats | head -40` closes the pipe as soon as it has its forty
 * lines, and the next `process.stdout.write` then raises EPIPE — which Node
 * turns into an unhandled `error` event and a stack trace on top of the output
 * somebody was trying to read. A preview whose whole point is that its output
 * can be piped and pasted must not crash when it is.
 *
 * Registered explicitly from `main` rather than as a module-load side effect, so
 * that importing this module for `decodeKeys` in a test does not silently change
 * the process`s error handling.
 */
export const guardBrokenPipe = (): void => {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0)
    }
    throw error
  })
}

export const isInteractive = (): boolean =>
  process.stdin.isTTY === true && process.stdout.isTTY === true

const ENTER_ALT_SCREEN = `${ESC}[?1049h`
const LEAVE_ALT_SCREEN = `${ESC}[?1049l`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const HOME = `${ESC}[H`
const CLEAR_TO_END = `${ESC}[J`
const CLEAR_TO_LINE_END = `${ESC}[K`

export const enterFullScreen = (): void => {
  write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}${HOME}${CLEAR_TO_END}`)
  if (typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
}

export const leaveFullScreen = (): void => {
  if (typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(false)
  }
  process.stdin.pause()
  write(`${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`)
}

/**
 * Redraw in place rather than clearing first, so the frame does not flash.
 * Each line is cleared to its own end, which is what stops a short HUD line
 * from leaving the tail of the previous, longer one behind it.
 */
export const paintFrame = (lines: ReadonlyArray<string>): void => {
  write(HOME + lines.map((line) => line + CLEAR_TO_LINE_END).join(NEWLINE) + CLEAR_TO_END)
}

const ETX = String.fromCharCode(3)
const CARRIAGE_RETURN = String.fromCharCode(13)

/**
 * Normalised key names.
 *
 * Arrow keys arrive as three-byte escape sequences and a bare Escape arrives as
 * one byte, so a naive `chunk[0]` reading treats Escape and every arrow key as
 * the same keystroke.
 */
const KEY_NAMES: ReadonlyMap<string, string> = new Map([
  [`${ESC}[A`, 'up'],
  [`${ESC}[B`, 'down'],
  [`${ESC}[C`, 'right'],
  [`${ESC}[D`, 'left'],
  [ESC, 'escape'],
  [ETX, 'ctrl-c'],
  [CARRIAGE_RETURN, 'enter'],
  [NEWLINE, 'enter'],
])

export const decodeKey = (chunk: string): string => KEY_NAMES.get(chunk) ?? chunk

const ARROWS: ReadonlyMap<string, string> = new Map([
  ['A', 'up'],
  ['B', 'down'],
  ['C', 'right'],
  ['D', 'left'],
])

/**
 * Split one stdin chunk into individual keys.
 *
 * A `data` event is a chunk of BYTES, not a keystroke. Holding a key, typing
 * quickly and pasting all deliver several keystrokes in one chunk, and an arrow
 * key is three bytes that must stay together.
 */
export const decodeKeys = (chunk: string): ReadonlyArray<string> => {
  const keys: Array<string> = []
  let index = 0

  while (index < chunk.length) {
    const character = chunk.charAt(index)

    if (character === ESC && chunk.charAt(index + 1) === '[') {
      const arrow = ARROWS.get(chunk.charAt(index + 2))
      if (arrow !== undefined) {
        keys.push(arrow)
        index += 3
        continue
      }
    }

    keys.push(decodeKey(character))
    index += 1
  }

  return keys
}

export const onKey = (handler: (key: string) => void): void => {
  process.stdin.on('data', (chunk: string | Buffer) => {
    for (const key of decodeKeys(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))) {
      handler(key)
    }
  })
}

/**
 * End of input. Without this the app waits forever on a closed stdin, which is
 * what happens whenever someone pipes keys into it.
 */
export const onInputEnd = (handler: () => void): void => {
  process.stdin.on('end', handler)
}

export const onResize = (handler: () => void): void => {
  process.stdout.on('resize', handler)
}

export const onExit = (handler: () => void): void => {
  process.on('exit', handler)
  process.on('SIGINT', () => {
    handler()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    handler()
    process.exit(0)
  })
}
