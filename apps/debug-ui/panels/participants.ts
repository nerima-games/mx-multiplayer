import { Effect } from 'effect'
import {
  type ReconnectAuth,
  type ReconnectAuthCrypto,
  type ReconnectAuthStore,
  ReconnectToken,
  ReconnectTokenInput,
  createReconnectAuth,
} from '../../../src/application/server/reconnect-auth.js'
import { AUTHORITY_SCENARIOS } from '../../../scenarios/authority.js'
import { createScenarioRuntime } from '../../../scenarios/runtime.js'
import { disconnectScenario } from '../../../scenarios/transport.js'
import type { ScenarioDefinition, ScenarioFault, ScenarioRuntime, ScenarioRuntimeClientId, ScenarioRuntimeOptions, ScenarioResult } from '../../../scenarios/types.js'
import type { DebugPanel } from './types.js'

const SNAPSHOT_SCENARIO_ID = 'world-sync.snapshot-transfer-convergence'
const JOINING_CLIENT_ID: ScenarioRuntimeClientId = 'client-c'
const JOIN_FRAME_COUNT = 1
const ALICE_ID = 'alice'
const BOB_ID = 'bob'
const TOKEN_LENGTH = 43
const TOKEN_HASH_MULTIPLIER = 33
const TOKEN_HASH_MODULUS = 0x1_0000_0000
const TOKEN_HASH_WORD_LENGTH = 8
const TOKEN_HASH_WORD_COUNT = 8
const TOKEN_HASH_RADIX = 16
const TOKEN_VALUES = [
  'A'.repeat(TOKEN_LENGTH),
  'B'.repeat(TOKEN_LENGTH),
  'C'.repeat(TOKEN_LENGTH),
  'D'.repeat(TOKEN_LENGTH),
] as const
const FORGED_TOKEN = 'Z'.repeat(TOKEN_LENGTH)

type Listener = {
  readonly button: HTMLButtonElement
  readonly handler: EventListener
}

const deterministicHash = (token: string): string => {
  let hash = 0
  for (const character of token) {
    hash = (Math.imul(hash, TOKEN_HASH_MULTIPLIER) + character.charCodeAt(0)) % TOKEN_HASH_MODULUS
  }
  return hash.toString(TOKEN_HASH_RADIX).padStart(TOKEN_HASH_WORD_LENGTH, '0').repeat(TOKEN_HASH_WORD_COUNT)
}

const makeTestCrypto = (): ReconnectAuthCrypto => {
  let tokenIndex = 0
  return {
    hashHex: deterministicHash,
    randomToken: () => {
      const value = TOKEN_VALUES[tokenIndex]
      if (value === undefined) {
        throw new RangeError('ReconnectAuth test token fixture exhausted')
      }
      tokenIndex += 1
      return ReconnectToken.make(value)
    },
    timingSafeEqualHex: (left, right) => left === right,
  }
}

const makeMemoryStore = (): ReconnectAuthStore => {
  let contents: string | undefined = undefined
  return {
    load: () => Effect.sync(() => contents),
    save: (next) => Effect.sync(() => { contents = next }),
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

const findSnapshotScenario = (): ScenarioDefinition | undefined =>
  AUTHORITY_SCENARIOS.find((scenario) => scenario.id === SNAPSHOT_SCENARIO_ID)

const describeClient = (result: ScenarioResult | undefined, clientId: ScenarioRuntimeClientId): string => {
  const client = result?.runtimeClients.find((candidate) => candidate.id === clientId)
  if (client === undefined) {
    return 'No runtime client state is available.'
  }
  const connection = client.connected ? 'connected' : 'disconnected'
  return `${client.id} (${client.player}): ${connection}; ${client.lastDecision}`
}

const describeClientProjection = (result: ScenarioResult | undefined, clientId: ScenarioRuntimeClientId): string => {
  const projection = result?.clientProjections.find((candidate) => candidate.id === clientId)
  if (projection === undefined) {
    return 'No snapshot projection is available.'
  }
  const worlds = projection.worlds.map((world) => {
    const blocks = world.blocks.map(({ block, entityId, revision }) =>
      `${entityId} revision ${String(revision)} ${block.reading._tag}`)
    return `${world.world} revision ${String(world.revision)}; ${String(world.blocks.length)} block(s)${blocks.length === 0 ? '' : `: ${blocks.join(', ')}`}`
  })
  return worlds.length === 0 ? 'Snapshot applied with no world projections.' : worlds.join('; ')
}

const participantsPanel: DebugPanel = {
  id: 'participants',
  title: 'Join and reconnect',
  mount: (target, initialContext) => {
    const heading = document.createElement('p')
    heading.textContent = 'Client state and reconnect authentication use the selected deterministic scenarios and ReconnectAuth API.'

    const joinSupport = document.createElement('p')
    joinSupport.dataset['testid'] = 'participants-join-support'
    joinSupport.textContent = 'The snapshot scenario advances one frame, then joins client C through the runtime snapshot transfer path.'

    const runSummary = document.createElement('p')
    runSummary.dataset['testid'] = 'participants-run-summary'
    runSummary.textContent = 'No scenario has run.'

    const joinFrame = document.createElement('p')
    joinFrame.dataset['testid'] = 'participants-join-frame'
    joinFrame.textContent = 'No mid-run join has run.'

    const clientList = document.createElement('div')
    clientList.dataset['testid'] = 'participants-clients'
    const clientA = document.createElement('p')
    clientA.dataset['testid'] = 'participant-client-a'
    const clientB = document.createElement('p')
    clientB.dataset['testid'] = 'participant-client-b'
    const clientC = document.createElement('p')
    clientC.dataset['testid'] = 'participant-client-c'
    const clientCProjection = document.createElement('p')
    clientCProjection.dataset['testid'] = 'participant-client-c-projection'
    setText(clientA, describeClient(undefined, 'client-a'))
    setText(clientB, describeClient(undefined, 'client-b'))
    setText(clientC, describeClient(undefined, JOINING_CLIENT_ID))
    setText(clientCProjection, describeClientProjection(undefined, JOINING_CLIENT_ID))
    clientList.append(clientA, clientB, clientC, clientCProjection)

    const snapshotButton = makeButton('Run scenario and join client C')
    const disconnectButton = makeButton('Run disconnect scenario')
    const issueButton = makeButton('Issue Alice and Bob reconnect tokens')
    const reconnectButton = makeButton('Reconnect Alice with current token')
    const forgedButton = makeButton('Try forged token')
    const mismatchButton = makeButton('Try Alice token as Bob')

    const cryptoNotice = document.createElement('p')
    cryptoNotice.textContent = 'ReconnectAuth uses a deterministic in-memory test crypto/store fixture here; it is not production crypto or persistence.'

    const authState = document.createElement('p')
    authState.dataset['testid'] = 'participants-auth-state'
    authState.textContent = 'ReconnectAuth is initializing.'

    const authAttempt = document.createElement('p')
    authAttempt.dataset['testid'] = 'participants-auth-attempt'
    authAttempt.textContent = 'No reconnect attempt has run.'

    const expiry = document.createElement('p')
    expiry.dataset['testid'] = 'participants-expiry'
    expiry.textContent = 'Token expiry is enforced by ReconnectAuth, but the API does not expose a per-token expiry time.'

    target.append(
      heading,
      joinSupport,
      snapshotButton,
      disconnectButton,
      runSummary,
      joinFrame,
      clientList,
      issueButton,
      reconnectButton,
      forgedButton,
      mismatchButton,
      cryptoNotice,
      authState,
      authAttempt,
      expiry,
    )

    const listeners: Listener[] = []
    let context = initialContext
    let runtime = context.runtime
    let scenarioResult: ScenarioResult | undefined = runtime?.snapshot()
    let auth: ReconnectAuth | undefined = undefined
    let authInitializationFailed = false
    let aliceToken: string | undefined = undefined
    let bobToken: string | undefined = undefined
    let authBusy = false
    let scenarioBusy = false
    let disposed = false
    let lastStateFrame = context.state.frame
    let lastPlaying = context.state.play

    const addListener = (button: HTMLButtonElement, handler: () => void | Promise<void>): void => {
      const listener: EventListener = () => handler()
      button.addEventListener('click', listener)
      listeners.push({ button, handler: listener })
    }

    const renderAuth = (): void => {
      if (authInitializationFailed) {
        setText(authState, 'ReconnectAuth could not initialize.')
      } else if (auth === undefined) {
        setText(authState, 'ReconnectAuth is initializing.')
      } else {
        const alice = auth.has(ALICE_ID) ? 'stored entry present' : 'no stored entry'
        const bob = auth.has(BOB_ID) ? 'stored entry present' : 'no stored entry'
        setText(authState, `Alice: ${alice}; Bob: ${bob}. Token values are hidden.`)
      }
      issueButton.disabled = auth === undefined || authBusy || aliceToken !== undefined || bobToken !== undefined
      reconnectButton.disabled = auth === undefined || authBusy || aliceToken === undefined
      forgedButton.disabled = auth === undefined || authBusy || aliceToken === undefined
      mismatchButton.disabled = auth === undefined || authBusy || aliceToken === undefined || bobToken === undefined
    }

    const renderScenario = (): void => {
      setText(clientA, describeClient(scenarioResult, 'client-a'))
      setText(clientB, describeClient(scenarioResult, 'client-b'))
      setText(clientC, describeClient(scenarioResult, JOINING_CLIENT_ID))
      setText(clientCProjection, describeClientProjection(scenarioResult, JOINING_CLIENT_ID))
      if (scenarioResult === undefined) {
        setText(runSummary, 'No scenario has run.')
      } else {
        setText(runSummary, `${scenarioResult.id}; frame ${String(scenarioResult.frame)}; ${scenarioResult.verdict.status}: ${scenarioResult.verdict.summary}`)
      }
      snapshotButton.disabled = scenarioBusy
      disconnectButton.disabled = scenarioBusy
    }

    const refreshScenario = (nextRuntime: ScenarioRuntime | undefined): void => {
      runtime = nextRuntime
      scenarioResult = runtime?.snapshot()
      renderScenario()
    }

    const runScenario = async (
      definition: ScenarioDefinition | undefined,
      fault: ScenarioFault,
      joinClient = false,
    ): Promise<void> => {
      if (scenarioBusy || disposed) {
        return
      }
      if (definition === undefined) {
        setText(runSummary, `Unsupported: scenario ${SNAPSHOT_SCENARIO_ID} is not registered.`)
        return
      }
      scenarioBusy = true
      renderScenario()
      try {
        const options: ScenarioRuntimeOptions = {
          fault,
          frame: 0,
          panel: context.state.panel,
          play: false,
          seed: context.state.seed,
          speed: context.state.speed,
        }
        const nextRuntime = await createScenarioRuntime(definition, options)
        if (disposed) {
          return
        }
        context.setScenario(definition)
        context.setState({ fault: fault.kind, frame: 0, play: 0 })
        runtime = nextRuntime
        scenarioResult = nextRuntime.snapshot()
        setText(joinFrame, 'No mid-run join has run.')
        if (joinClient) {
          const beforeJoin = await nextRuntime.run(JOIN_FRAME_COUNT)
          context.setState({ frame: beforeJoin.frame })
          scenarioResult = await nextRuntime.join(JOINING_CLIENT_ID)
          setText(joinFrame, `client-c joined at frame ${String(scenarioResult.frame)} after frame ${String(beforeJoin.frame)} was processed.`)
        } else if (fault.kind === 'disconnect') {
          scenarioResult = await nextRuntime.step()
          context.setState({ frame: scenarioResult.frame })
        }
        context.setRuntime(nextRuntime)
        renderScenario()
      } catch {
        if (!disposed) {
          setText(runSummary, 'Scenario runtime operation failed.')
          scenarioResult = undefined
          renderScenario()
        }
      } finally {
        scenarioBusy = false
        if (!disposed) {
          renderScenario()
        }
      }
    }

    const runAuth = async (operation: (currentAuth: ReconnectAuth) => Promise<void>): Promise<void> => {
      if (auth === undefined || authBusy || disposed) {
        return
      }
      authBusy = true
      renderAuth()
      try {
        await operation(auth)
      } catch {
        if (!disposed) {
          setText(authAttempt, 'ReconnectAuth operation failed.')
        }
      } finally {
        authBusy = false
        if (!disposed) {
          renderAuth()
        }
      }
    }

    addListener(snapshotButton, () => runScenario(findSnapshotScenario(), { kind: 'none' }, true))
    addListener(disconnectButton, () => runScenario(disconnectScenario, { kind: 'disconnect', clientId: 'client-a' }))
    addListener(issueButton, () =>
      runAuth(async (currentAuth) => {
        const issuedAlice = await Effect.runPromise(currentAuth.issue(ALICE_ID))
        const issuedBob = await Effect.runPromise(currentAuth.issue(BOB_ID))
        if (issuedAlice === undefined || issuedBob === undefined) {
          setText(authAttempt, 'ReconnectAuth did not issue both player tokens.')
          return
        }
        aliceToken = issuedAlice
        bobToken = issuedBob
        setText(authAttempt, 'ReconnectAuth issued tokens for Alice and Bob; token values are hidden.')
      }),
    )
    addListener(reconnectButton, () =>
      runAuth(async (currentAuth) => {
        if (aliceToken === undefined) {
          setText(authAttempt, 'Rejected: Alice has no current reconnect token.')
          return
        }
        const resumed = await Effect.runPromise(currentAuth.resume(ReconnectTokenInput.make(aliceToken)))
        if (resumed === undefined) {
          setText(authAttempt, 'Rejected: ReconnectAuth found no matching owner for Alice’s current token.')
          return
        }
        const player = String(resumed.player)
        if (player === ALICE_ID) {
          aliceToken = resumed.token
        } else if (player === BOB_ID) {
          bobToken = resumed.token
        }
        setText(authAttempt, `Accepted: ${player} resumed; ReconnectAuth rotated the token.`)
      }),
    )
    addListener(forgedButton, () =>
      runAuth(async (currentAuth) => {
        const resumed = await Effect.runPromise(currentAuth.resume(ReconnectTokenInput.make(FORGED_TOKEN)))
        if (resumed === undefined) {
          setText(authAttempt, 'Rejected: ReconnectAuth found no matching owner for the forged token.')
        } else {
          const player = String(resumed.player)
          if (player === ALICE_ID) {
            aliceToken = resumed.token
          } else if (player === BOB_ID) {
            bobToken = resumed.token
          }
          setText(authAttempt, `Accepted unexpectedly: ${player} resumed; ReconnectAuth rotated the token.`)
        }
      }),
    )
    addListener(mismatchButton, () =>
      runAuth(async (currentAuth) => {
        if (aliceToken === undefined) {
          setText(authAttempt, 'Rejected: Alice has no current reconnect token.')
          return
        }
        const rotated = await Effect.runPromise(currentAuth.rotate(BOB_ID, aliceToken))
        if (rotated === undefined) {
          setText(authAttempt, 'Rejected: ReconnectAuth.rotate for Bob returned no token for Alice’s token.')
        } else {
          bobToken = rotated
          setText(authAttempt, 'Accepted unexpectedly: Bob’s token rotated from Alice’s token.')
        }
      }),
    )

    renderScenario()
    renderAuth()

    Effect.runPromise(createReconnectAuth(makeTestCrypto(), makeMemoryStore()))
      .then((createdAuth) => {
        if (!disposed) {
          auth = createdAuth
          renderAuth()
        }
      })
      .catch(() => {
        if (!disposed) {
          authInitializationFailed = true
          renderAuth()
        }
      })

    return {
      update: (nextContext) => {
        const runtimeChanged = nextContext.runtime !== runtime
        const frameChangedWhilePaused = nextContext.state.frame !== lastStateFrame && nextContext.state.play === 0
        const justPaused = nextContext.state.play === 0 && lastPlaying === 1
        context = nextContext
        lastStateFrame = nextContext.state.frame
        lastPlaying = nextContext.state.play
        if (runtimeChanged || frameChangedWhilePaused || justPaused) {
          refreshScenario(nextContext.runtime)
        }
      },
      dispose: () => {
        disposed = true
        for (const { button, handler } of listeners) {
          button.removeEventListener('click', handler)
        }
        listeners.length = 0
      },
    }
  },
}

export default participantsPanel
