import {
  AuthoritativeRevisionTracker,
  WorldId,
  decodeFrame,
  encodeFrame,
} from '../src/index.js'
import type { NetworkMessage, WorldSnapshot } from '../src/domain/protocol.js'
import type { ScenarioDefinition, ScenarioEvaluationInput, ScenarioVerdict } from './types.js'
import { Result } from 'effect'
import type { RevisionAdmission } from '../src/domain/authoritative-sync.js'

const ONE = 1
const FIXED_WORLD_SEED = 41
const INITIAL_REVISION = 3
const RECONNECT_REVISION = 5
const WORLD = WorldId.make('world-sync-overworld')

const worldSnapshot = (revision: number): WorldSnapshot => ({
  _tag: 'WorldSnapshot',
  blocks: [],
  levers: [],
  players: [],
  poweredRails: [],
  revision,
  seed: FIXED_WORLD_SEED,
  world: WORLD,
})

const roundTripMessage = (message: NetworkMessage): NetworkMessage =>
  Result.getOrThrow(decodeFrame(Result.getOrThrow(encodeFrame(message))))

const decodedWorldSnapshot = (revision: number): WorldSnapshot => {
  const decoded = roundTripMessage(worldSnapshot(revision))
  if (decoded._tag !== 'WorldSnapshot') {
    throw new Error(`expected WorldSnapshot, received ${decoded._tag}`)
  }
  return decoded
}

type WorldSyncReconnectSnapshotProbe = Readonly<{
  initial: RevisionAdmission
  reconnect: RevisionAdmission
  updateAfterDisconnect: RevisionAdmission
  updateAfterReconnect: RevisionAdmission
  updateBeforeSnapshot: RevisionAdmission
}>

export const runWorldSyncReconnectSnapshotProbe = (): WorldSyncReconnectSnapshotProbe => {
  const tracker = new AuthoritativeRevisionTracker()
  const updateBeforeSnapshot = tracker.ingestRevision(WORLD, INITIAL_REVISION)
  const initialAdmission = tracker.ingestSnapshot(decodedWorldSnapshot(INITIAL_REVISION))
  tracker.disconnect(WORLD)
  const updateAfterDisconnect = tracker.ingestRevision(WORLD, RECONNECT_REVISION)
  const reconnectAdmission = tracker.ingestSnapshot(decodedWorldSnapshot(RECONNECT_REVISION))
  const updateAfterReconnect = tracker.ingestRevision(WORLD, RECONNECT_REVISION + ONE)
  return {
    initial: initialAdmission,
    reconnect: reconnectAdmission,
    updateAfterDisconnect,
    updateAfterReconnect,
    updateBeforeSnapshot,
  }
}

const reconnectSnapshotPasses = (): boolean => {
  const probe = runWorldSyncReconnectSnapshotProbe()
  return probe.initial?.accepted === true
    && !probe.updateBeforeSnapshot.accepted
    && probe.updateBeforeSnapshot.reason === 'snapshot-required'
    && !probe.updateAfterDisconnect?.accepted
    && probe.updateAfterDisconnect?.reason === 'snapshot-required'
    && probe.reconnect?.accepted === true
    && probe.updateAfterReconnect?.accepted === true
}

const verdict = (passed: boolean, passSummary: string): ScenarioVerdict => {
  if (passed) {
    return { status: 'pass', summary: passSummary }
  }
  return { status: 'fail', summary: 'world-sync lifecycle assertion failed' }
}

const noActions = () => []
const noRuntimeStateNeeded = (_input: ScenarioEvaluationInput): ScenarioVerdict =>
  verdict(reconnectSnapshotPasses(), 'a reconnect requires a fresh world snapshot before accepting later revisions')

export const worldSyncReconnectSnapshotScenario: ScenarioDefinition = {
  actions: noActions,
  angle: 'A5',
  description: 'A decoded WorldSnapshot restores the revision baseline after disconnect; deltas stay blocked until then.',
  evaluate: noRuntimeStateNeeded,
  group: 'authority',
  id: 'world-sync.reconnect.snapshot-required',
  title: 'Reconnect from a complete world snapshot',
}

