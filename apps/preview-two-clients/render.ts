/**
 * Every renderer, as a pure function of its arguments.
 *
 * A dev application, not shipped API.
 *
 * Pure so that `--script` produces byte-identical output for the same session,
 * which is what makes a pasted transcript a piece of evidence rather than an
 * anecdote. The `Style` is threaded rather than read from a global for the
 * reason `ansi.ts` gives.
 */
import { padEnd, padStart, type Rgb, type Style } from './ansi'
import { PROTOCOL_VERSION } from '../../domain/protocol'
import {
  MACHINE_FAULTS,
  SCRIPT,
  WIRE_FAULTS,
  WIRE_FAULT_HELP,
  maySend,
  stateLabel,
  type Peer,
  type Session,
} from './session'

export const VIEW_MODES = ['wire', 'machine', 'faults'] as const
export type ViewMode = (typeof VIEW_MODES)[number]

export const isViewMode = (value: string): value is ViewMode =>
  (VIEW_MODES as ReadonlyArray<string>).includes(value)

const GOOD: Rgb = [140, 200, 140]
const BAD: Rgb = [235, 120, 120]
const WARN: Rgb = [235, 180, 90]
const CLIENT: Rgb = [130, 180, 240]
const SERVER: Rgb = [200, 160, 230]

// ---------------------------------------------------------------------------
// wire
// ---------------------------------------------------------------------------

const WIRE_HEADER =
  padStart('#', 4) +
  '  ' +
  padEnd('from', 8) +
  padEnd('tag', 15) +
  padStart('v', 3) +
  padStart('bytes', 7) +
  '  ' +
  padEnd('fault', 16) +
  'verdict'

/**
 * The frame log.
 *
 * THIS IS WHY THE APP EXISTS. `test/transport.test.ts` asserts that a message
 * arrives equal to the one sent, and `test/codec.test.ts` asserts what a
 * malformed frame decodes to — but neither can show a SESSION, and a session is
 * where the two failure channels DN-2 is about actually get confused. A row here
 * carries the frame's whole life: who sent it, what was done to it, how many
 * bytes crossed, and what the far end said about it in the far end's own words.
 *
 * The `v` column is the envelope's `protocolVersion`, printed on every row
 * because DN-1's entire argument is that it is on the ENVELOPE and can therefore
 * be read before the message is.
 */
export const renderWire = (
  session: Session,
  style: Style,
  rows: number,
  showText: boolean,
): ReadonlyArray<string> => {
  const lines: Array<string> = [style.bold(WIRE_HEADER), style.dim('-'.repeat(WIRE_HEADER.length))]
  const visible = Math.max(4, rows - 6)
  const tail = session.wire.slice(-visible)

  for (const row of tail) {
    const body =
      padStart(String(row.seq), 4) +
      '  ' +
      style.paint(padEnd(row.from, 8), row.from === 'client' ? CLIENT : SERVER) +
      padEnd(row.tag, 15) +
      padStart(row.version === 0 ? '?' : String(row.version), 3) +
      padStart(String(row.bytes), 7) +
      '  ' +
      padEnd(row.fault ?? '', 16) +
      (row.failed ? style.paint(row.verdict, BAD) : style.paint(row.verdict, GOOD))
    lines.push(body)
    if (showText && row.text !== undefined) {
      lines.push(style.dim(`      ${row.text.slice(0, 140)}`))
    }
  }

  if (session.wire.length === 0) {
    lines.push(style.dim('  (nothing has crossed the wire yet — press SPACE)'))
  }

  const failed = session.wire.filter((row) => row.failed).length
  lines.push('')
  lines.push(
    style.dim(
      `  frames ${String(session.wire.length)}   rejected or refused ${String(failed)}   ` +
        `bytes ${String(session.wire.reduce((sum, row) => sum + row.bytes, 0))}`,
    ),
  )

  return lines
}

// ---------------------------------------------------------------------------
// machine
// ---------------------------------------------------------------------------

const peerBlock = (target: Peer, style: Style): ReadonlyArray<string> => [
  style.bold(`  ${target.name}`),
  `    state              ${stateLabel(target.state)}`,
  `    canSend()          ${String(maySend(target))}`,
  `    identity           ${target.identity ?? '(none yet)'}`,
  `    illegal events     ${String(target.rejectedEvents)}`,
  `    pings outstanding  ${String(target.outstandingPings.length)}`,
]

/**
 * Both machines, and every transition either of them has been asked for.
 *
 * `REJECTED` rows are the ones to read. `transition` returns `undefined` for an
 * illegal event rather than the unchanged state, and DN-8 says why: a caller
 * that gets the unchanged state cannot tell "nothing to do" from "you asked for
 * something incoherent". Every rejected row below is a place where an adapter
 * would have to decide which of those two it was, with nothing but the
 * `undefined` to go on.
 */
export const renderMachine = (session: Session, style: Style, rows: number): ReadonlyArray<string> => {
  const lines: Array<string> = [
    ...peerBlock(session.client, style),
    '',
    ...peerBlock(session.server, style),
    '',
    style.bold(
      `  ${padStart('#', 4)}  ${padEnd('side', 8)}${padEnd('event', 32)}${padEnd('from', 26)}to`,
    ),
    style.dim('  ' + '-'.repeat(92)),
  ]

  const visible = Math.max(4, rows - lines.length - 3)
  for (const row of session.events.slice(-visible)) {
    const body =
      `  ${padStart(String(row.seq), 4)}  ` +
      style.paint(padEnd(row.side, 8), row.side === 'client' ? CLIENT : SERVER) +
      padEnd(row.event, 32) +
      padEnd(row.from, 26) +
      row.to
    lines.push(row.rejected ? style.paint(body, BAD) : body)
  }

  if (session.events.length === 0) {
    lines.push(style.dim('  (no transitions yet)'))
  }

  return lines
}

// ---------------------------------------------------------------------------
// faults
// ---------------------------------------------------------------------------

export const renderFaults = (session: Session, style: Style): ReadonlyArray<string> => {
  const lines: Array<string> = [
    style.bold('fault injection'),
    style.dim('These are the paths that are hard to reach in a test and impossible to reach by hand'),
    style.dim('against a real peer. Everything below acts on the REAL codec, transport and machine.'),
    '',
    style.bold('  wire faults — one-shot, applied to the NEXT frame that leaves a peer   (f cycles)'),
    '',
  ]

  for (const fault of WIRE_FAULTS) {
    const marker = fault === session.armed ? style.paint(' >', WARN) : '  '
    lines.push(`${marker} ${padEnd(fault, 18)}${style.dim(WIRE_FAULT_HELP[fault])}`)
  }

  lines.push('')
  lines.push(style.bold('  machine faults — fired immediately, against whatever state we are in'))
  lines.push('')
  for (const fault of MACHINE_FAULTS) {
    lines.push(`   ${style.bold(fault.key)}  ${padEnd(fault.label, 44)}`)
    lines.push(`      ${style.dim(fault.why)}`)
  }

  lines.push('')
  lines.push(
    style.dim(
      `  this build speaks protocol version ${String(PROTOCOL_VERSION)}; ` +
        `wrong-version and future-message forge ${String(PROTOCOL_VERSION + 1)}`,
    ),
  )

  return lines
}

// ---------------------------------------------------------------------------
// the step banner, shown on every view
// ---------------------------------------------------------------------------

export const stepBanner = (session: Session, style: Style): ReadonlyArray<string> => {
  const next = SCRIPT[session.step]
  if (next === undefined) {
    return [style.dim('script finished — r resets, or use the machine faults to keep going')]
  }
  return [
    `${style.bold(`next (${String(session.step + 1)}/${String(SCRIPT.length)})`)}  ${next.label}`,
    style.dim(`  watch: ${next.watch}`),
  ]
}
