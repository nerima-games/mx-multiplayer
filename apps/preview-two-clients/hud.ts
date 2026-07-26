/**
 * The status lines under the picture, and the help overlay.
 *
 * A dev application, not shipped API.
 *
 * `HUD_ROWS` is exported because the frame budget has to be computed before the
 * HUD is rendered, and a hard-coded 4 in two places is how a preview ends up
 * scrolling by one line on every keystroke.
 */
import { padEnd, type Style } from './ansi'
import { USAGE } from './options'
import type { ViewMode } from './render'
import { SCRIPT, stateLabel, WIRE_FAULT_HELP, type Session } from './session'

export const HUD_ROWS = 4

export type HudState = {
  readonly view: ViewMode
  readonly showText: boolean
}

export const buildHud = (hud: HudState, session: Session, style: Style): ReadonlyArray<string> => {
  const rejected = session.client.rejectedEvents + session.server.rejectedEvents
  const failedFrames = session.wire.filter((row) => row.failed).length

  return [
    style.dim('-'.repeat(78)),
    [
      style.bold(`step ${padEnd(`${String(session.step)}/${String(SCRIPT.length)}`, 7)}`),
      `view ${padEnd(hud.view, 9)}`,
      `client ${padEnd(stateLabel(session.client.state), 30)}`,
      `server ${stateLabel(session.server.state)}`,
    ].join(' '),
    [
      `frames ${padEnd(String(session.wire.length), 5)}`,
      `rejected frames ${padEnd(String(failedFrames), 4)}`,
      `illegal events ${padEnd(String(rejected), 4)}`,
      `armed ${padEnd(session.armed, 16)}`,
      hud.showText ? 'text on' : 'text off',
    ].join(' '),
    session.armed === 'none'
      ? style.dim(session.note)
      : style.paint(`${session.armed}: ${WIRE_FAULT_HELP[session.armed]}`, [235, 180, 90]),
  ]
}

export const buildHelp = (style: Style): ReadonlyArray<string> =>
  [style.bold('preview-two-clients'), '', ...USAGE, '', style.dim('any key returns')]
