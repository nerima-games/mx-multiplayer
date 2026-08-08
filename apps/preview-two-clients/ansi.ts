/**
 * Colour, in the smallest form that does the job.
 *
 * A dev application, not shipped API.
 *
 * ---------------------------------------------------------------------------
 * Why there is no colour library here
 * ---------------------------------------------------------------------------
 *
 * `pnpm check:deps` gates `apps/` exactly like `domain/` (`SCAN_ROOTS`,
 * `scripts/check-dependency-whitelist.ts:238`), and a dependency added for a dev
 * tool is still a dependency in the lockfile that CI installs. Two dozen lines
 * of escape sequences are cheaper than that. mc-worldgen's terrain preview,
 * mx-redstone's circuit board and mx-gameplay's mining site all reached the same
 * conclusion and none of them added one either.
 *
 * ---------------------------------------------------------------------------
 * Why colour is threaded rather than read from a global
 * ---------------------------------------------------------------------------
 *
 * `--ascii` exists so a transcript can be pasted into an issue or a commit
 * message. A log full of `ESC[38;2;…m` would defeat that entirely, so every renderer
 * here takes a `Style` and `PLAIN_STYLE` turns every call into the identity.
 * That also keeps the renderers pure functions of their arguments, which is what
 * makes `--script` produce byte-identical output for the same session.
 *
 * Adapted from mx-redstone's `apps/preview-circuit-board/ansi.ts`. The two are
 * deliberately separate copies: these are independent repositories, and a shared
 * preview harness would be a cross-repository dependency created for the
 * convenience of dev tooling — exactly the edge `pnpm check:deps` exists to
 * refuse.
 */

export type Rgb = readonly [number, number, number]

/**
 * ESC (0x1B).
 *
 * Built with `String.fromCharCode` rather than written as a literal, so no raw
 * control byte sits in a source file that `grep`, `git diff` and the dependency
 * gate's source masker all have to read.
 */
export const ESC: string = String.fromCharCode(27)

export const RESET = `${ESC}[0m`

const foreground = (color: Rgb): string =>
  `${ESC}[38;2;${String(color[0])};${String(color[1])};${String(color[2])}m`

const background = (color: Rgb): string =>
  `${ESC}[48;2;${String(color[0])};${String(color[1])};${String(color[2])}m`

/**
 * How a renderer emits colour.
 *
 * `cell` exists separately from `paint` because the selected row of the wire log
 * is drawn as a reversed cell; expressing that as "foreground + background"
 * rather than "text + escape soup" keeps the renderer readable.
 */
export type Style = {
  readonly paint: (text: string, color: Rgb) => string
  readonly cell: (text: string, color: Rgb, backdrop: Rgb | undefined) => string
  readonly bold: (text: string) => string
  readonly dim: (text: string) => string
}

export const ANSI_STYLE: Style = {
  bold: (text) => `${ESC}[1m${text}${ESC}[22m`,
  cell: (text, color, backdrop) =>
    `${backdrop === undefined ? '' : background(backdrop)}${foreground(color)}${text}${RESET}`,
  dim: (text) => `${ESC}[2m${text}${ESC}[22m`,
  paint: (text, color) => `${foreground(color)}${text}${RESET}`,
}

export const PLAIN_STYLE: Style = {
  bold: (text) => text,
  cell: (text) => text,
  dim: (text) => text,
  paint: (text) => text,
}

/** Interpolate between two colours. Kept for the same reason the copy it came from has it. */
export const mix = (low: Rgb, high: Rgb, amount: number): Rgb => {
  const t = Math.min(Math.max(amount, 0), 1)
  return [
    Math.round(low[0] + (high[0] - low[0]) * t),
    Math.round(low[1] + (high[1] - low[1]) * t),
    Math.round(low[2] + (high[2] - low[2]) * t),
  ]
}

export const padEnd = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length)

export const padStart = (text: string, width: number): string =>
  text.length >= width ? text : ' '.repeat(width - text.length) + text
