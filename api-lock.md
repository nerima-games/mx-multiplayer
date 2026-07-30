# API lock — @nerima-games/mx-multiplayer

<!-- ------------------------------------------------------------------------- -->
<!-- GENERATED FILE. Do not edit by hand.                                      -->
<!--                                                                           -->
<!-- Regenerate with `pnpm api:update`. `pnpm api:check`, which `pnpm verify`  -->
<!-- runs, fails when this file is stale.                                      -->
<!--                                                                           -->
<!-- Every line below is part of the published surface of this package. A diff -->
<!-- here is a diff in what consumers can see, and is the thing plan.md §6     -->
<!-- Step 0-3 asks to be reviewed as a diff. See scripts/api-lock.ts for how   -->
<!-- it is produced and why it is produced this way.                           -->
<!-- ------------------------------------------------------------------------- -->

format: 1
exported declarations: 82
supporting declarations: 10

## Exported

### BlockBreak  `const`

```ts
const BlockBreak: Schema.TaggedStruct<"BlockBreak", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    world: Schema.optional<Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">>;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
}>;
```

### BlockBreak  `type`

```ts
type BlockBreak = typeof BlockBreak.Type;
```

### BlockMutationRejected  `const`

```ts
const BlockMutationRejected: Schema.TaggedStruct<"BlockMutationRejected", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
    operation: Schema.Literal<["place", "break"]>;
    reason: Schema.Literal<["unauthorized-player", "unknown-block", "occupied", "missing-block", "out-of-bounds", "stale-revision"]>;
    revision: Schema.filter<Schema.filter<typeof Schema.Number>>;
}>;
```

### BlockMutationRejected  `type`

```ts
type BlockMutationRejected = typeof BlockMutationRejected.Type;
```

### BlockMutationRejectionReason  `const`

```ts
const BlockMutationRejectionReason: Schema.Literal<["unauthorized-player", "unknown-block", "occupied", "missing-block", "out-of-bounds", "stale-revision"]>;
```

### BlockMutationRejectionReason  `type`

```ts
type BlockMutationRejectionReason = typeof BlockMutationRejectionReason.Type;
```

### BlockMutationSnapshot  `const`

```ts
const BlockMutationSnapshot: Schema.Struct<{
    world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
    block: Schema.NullOr<Schema.filter<typeof Schema.String>>;
}>;
```

### BlockMutationSnapshot  `type`

```ts
type BlockMutationSnapshot = typeof BlockMutationSnapshot.Type;
```

### BlockPlace  `const`

```ts
const BlockPlace: Schema.TaggedStruct<"BlockPlace", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    world: Schema.optional<Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">>;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
    block: Schema.filter<typeof Schema.String>;
}>;
```

### BlockPlace  `type`

```ts
type BlockPlace = typeof BlockPlace.Type;
```

### BlockPos  `const`

```ts
const BlockPos: Schema.Struct<{
    x: Schema.filter<typeof Schema.Number>;
    y: Schema.filter<typeof Schema.Number>;
    z: Schema.filter<typeof Schema.Number>;
}>;
```

### BlockPos  `type`

```ts
type BlockPos = typeof BlockPos.Type;
```

### Chat  `const`

```ts
const Chat: Schema.TaggedStruct<"Chat", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    text: Schema.filter<Schema.filter<typeof Schema.String>>;
}>;
```

### Chat  `type`

```ts
type Chat = typeof Chat.Type;
```

### ConnectionEvent  `type`

```ts
type ConnectionEvent = {
    readonly _tag: 'ConnectRequested';
} | {
    readonly _tag: 'HandshakeSucceeded';
    readonly player: PlayerId;
    readonly world: WorldId;
} | {
    readonly _tag: 'HandshakeFailed';
} | {
    readonly _tag: 'PeerClosed';
} | {
    readonly _tag: 'TransportFailed';
    readonly reason: TransportErrorReason;
} | {
    readonly _tag: 'CloseRequested';
} | {
    readonly _tag: 'RetryRequested';
};
```

### ConnectionState  `type`

```ts
type ConnectionState = {
    readonly _tag: 'Disconnected';
} | {
    readonly _tag: 'Connecting';
    readonly attempt: number;
} | {
    readonly _tag: 'Connected';
    readonly player: PlayerId;
    readonly world: WorldId;
} | {
    readonly _tag: 'Closed';
    readonly reason: TransportErrorReason;
};
```

### EXPERIENCE_MODULE_STAGE_PREFIXES  `const`

```ts
const EXPERIENCE_MODULE_STAGE_PREFIXES: readonly ["gameplay:", "redstone:", "ui:", "multiplayer:"];
```

### Frame  `const`

```ts
const Frame: Schema.Struct<{
    protocolVersion: Schema.filter<typeof Schema.Number>;
    message: Schema.Union<[Schema.TaggedStruct<"PlayerJoin", {
        player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
        name: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerName">;
        at: Schema.Struct<{
            x: Schema.filter<typeof Schema.Number>;
            y: Schema.filter<typeof Schema.Number>;
            z: Schema.filter<typeof Schema.Number>;
        }>;
    }>, Schema.TaggedStruct<"PlayerLeave", {
        player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    }>, Schema.TaggedStruct<"PlayerMove", {
        player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
        world: Schema.optional<Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">>;
        at: Schema.Struct<{
            x: Schema.filter<typeof Schema.Number>;
            y: Schema.filter<typeof Schema.Number>;
            z: Schema.filter<typeof Schema.Number>;
        }>;
        facing: Schema.Struct<{
            yawRadians: Schema.filter<typeof Schema.Number>;
            pitchRadians: Schema.filter<typeof Schema.Number>;
        }>;
    }>, Schema.TaggedStruct<"BlockPlace", {
        player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
        world: Schema.optional<Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">>;
        at: Schema.Struct<{
            x: Schema.filter<typeof Schema.Number>;
            y: Schema.filter<typeof Schema.Number>;
            z: Schema.filter<typeof Schema.Number>;
        }>;
        block: Schema.filter<typeof Schema.String>;
    }>, Schema.TaggedStruct<"BlockBreak", {
        player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
        world: Schema.optional<Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">>;
        at: Schema.Struct<{
            x: Schema.filter<typeof Schema.Number>;
            y: Schema.filter<typeof Schema.Number>;
            z: Schema.filter<typeof Schema.Number>;
        }>;
    }>, Schema.TaggedStruct<"Chat", {
        player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
        text: Schema.filter<Schema.filter<typeof Schema.String>>;
    }>, Schema.TaggedStruct<"WorldInfo", {
        world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
        seed: Schema.filter<typeof Schema.Number>;
    }>, Schema.TaggedStruct<"WorldSnapshot", {
        world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
        seed: Schema.filter<typeof Schema.Number>;
        revision: Schema.filter<Schema.filter<typeof Schema.Number>>;
        players: Schema.Array$<Schema.Struct<{
            player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
            name: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerName">;
            world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
            at: Schema.Struct<{
                x: Schema.filter<typeof Schema.Number>;
                y: Schema.filter<typeof Schema.Number>;
                z: Schema.filter<typeof Schema.Number>;
            }>;
            facing: Schema.Struct<{
                yawRadians: Schema.filter<typeof Schema.Number>;
                pitchRadians: Schema.filter<typeof Schema.Number>;
            }>;
        }>>;
        blocks: Schema.Array$<Schema.Struct<{
            world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
            at: Schema.Struct<{
                x: Schema.filter<typeof Schema.Number>;
                y: Schema.filter<typeof Schema.Number>;
                z: Schema.filter<typeof Schema.Number>;
            }>;
            block: Schema.NullOr<Schema.filter<typeof Schema.String>>;
        }>>;
    }>, Schema.TaggedStruct<"BlockMutationRejected", {
        player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
        world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
        at: Schema.Struct<{
            x: Schema.filter<typeof Schema.Number>;
            y: Schema.filter<typeof Schema.Number>;
            z: Schema.filter<typeof Schema.Number>;
        }>;
        operation: Schema.Literal<["place", "break"]>;
        reason: Schema.Literal<["unauthorized-player", "unknown-block", "occupied", "missing-block", "out-of-bounds", "stale-revision"]>;
        revision: Schema.filter<Schema.filter<typeof Schema.Number>>;
    }>, Schema.TaggedStruct<"Ping", {
        nonce: Schema.filter<typeof Schema.Number>;
    }>, Schema.TaggedStruct<"Pong", {
        nonce: Schema.filter<typeof Schema.Number>;
    }>]>;
}>;
```

### Frame  `type`

```ts
type Frame = typeof Frame.Type;
```

### LoopbackTransportLayer  `const`

```ts
const LoopbackTransportLayer: (service: TransportService) => Layer.Layer<TransportPort>;
```

### MESSAGE_TAGS  `const`

```ts
const MESSAGE_TAGS: readonly ["PlayerJoin", "PlayerLeave", "PlayerMove", "BlockPlace", "BlockBreak", "Chat", "WorldInfo", "WorldSnapshot", "BlockMutationRejected", "Ping", "Pong"];
```

### MULTIPLAYER_STAGE_IDS  `const`

```ts
const MULTIPLAYER_STAGE_IDS: {
    readonly inbound: StageId;
    readonly outbound: StageId;
};
```

### MultiplayerFrameState  `type`

```ts
type MultiplayerFrameState = {
    readonly connection: Ref.Ref<ConnectionState>;
    readonly outbox: Ref.Ref<ReadonlyArray<NetworkMessage>>;
    readonly inbound: Ref.Ref<ReadonlyArray<NetworkMessage>>;
    readonly counters: Ref.Ref<NetworkFrameCounters>;
};
```

### MultiplayerHost  `type`

```ts
type MultiplayerHost = {
    readonly stages: ReadonlyArray<StageRegistration>;
    readonly module: GameModule<never, never, never, never>;
    readonly drainInbound: Effect.Effect<ReadonlyArray<NetworkMessage>>;
    readonly enqueueOutbound: (message: NetworkMessage) => Effect.Effect<void>;
    readonly connectionSnapshot: Effect.Effect<ConnectionState>;
    readonly transitionConnection: (event: ConnectionEvent) => Effect.Effect<ConnectionState | undefined>;
    readonly countersSnapshot: Effect.Effect<NetworkFrameCounters>;
};
```

### NO_NETWORK_FRAMES  `const`

```ts
const NO_NETWORK_FRAMES: NetworkFrameCounters;
```

### NetworkFrameCounters  `type`

```ts
type NetworkFrameCounters = {
    readonly received: number;
    readonly malformed: number;
    readonly versionMismatched: number;
    readonly sent: number;
    readonly unencodable: number;
    readonly sendFailed: number;
    readonly droppedWhileNotConnected: number;
};
```

### NetworkMessage  `const`

```ts
const NetworkMessage: Schema.Union<[Schema.TaggedStruct<"PlayerJoin", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    name: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerName">;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
}>, Schema.TaggedStruct<"PlayerLeave", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
}>, Schema.TaggedStruct<"PlayerMove", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    world: Schema.optional<Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">>;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
    facing: Schema.Struct<{
        yawRadians: Schema.filter<typeof Schema.Number>;
        pitchRadians: Schema.filter<typeof Schema.Number>;
    }>;
}>, Schema.TaggedStruct<"BlockPlace", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    world: Schema.optional<Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">>;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
    block: Schema.filter<typeof Schema.String>;
}>, Schema.TaggedStruct<"BlockBreak", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    world: Schema.optional<Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">>;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
}>, Schema.TaggedStruct<"Chat", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    text: Schema.filter<Schema.filter<typeof Schema.String>>;
}>, Schema.TaggedStruct<"WorldInfo", {
    world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
    seed: Schema.filter<typeof Schema.Number>;
}>, Schema.TaggedStruct<"WorldSnapshot", {
    world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
    seed: Schema.filter<typeof Schema.Number>;
    revision: Schema.filter<Schema.filter<typeof Schema.Number>>;
    players: Schema.Array$<Schema.Struct<{
        player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
        name: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerName">;
        world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
        at: Schema.Struct<{
            x: Schema.filter<typeof Schema.Number>;
            y: Schema.filter<typeof Schema.Number>;
            z: Schema.filter<typeof Schema.Number>;
        }>;
        facing: Schema.Struct<{
            yawRadians: Schema.filter<typeof Schema.Number>;
            pitchRadians: Schema.filter<typeof Schema.Number>;
        }>;
    }>>;
    blocks: Schema.Array$<Schema.Struct<{
        world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
        at: Schema.Struct<{
            x: Schema.filter<typeof Schema.Number>;
            y: Schema.filter<typeof Schema.Number>;
            z: Schema.filter<typeof Schema.Number>;
        }>;
        block: Schema.NullOr<Schema.filter<typeof Schema.String>>;
    }>>;
}>, Schema.TaggedStruct<"BlockMutationRejected", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
    operation: Schema.Literal<["place", "break"]>;
    reason: Schema.Literal<["unauthorized-player", "unknown-block", "occupied", "missing-block", "out-of-bounds", "stale-revision"]>;
    revision: Schema.filter<Schema.filter<typeof Schema.Number>>;
}>, Schema.TaggedStruct<"Ping", {
    nonce: Schema.filter<typeof Schema.Number>;
}>, Schema.TaggedStruct<"Pong", {
    nonce: Schema.filter<typeof Schema.Number>;
}>]>;
```

### NetworkMessage  `type`

```ts
type NetworkMessage = typeof NetworkMessage.Type;
```

### OWN_STAGE_PREFIX  `const`

```ts
const OWN_STAGE_PREFIX = "multiplayer:";
```

### Orientation  `const`

```ts
const Orientation: Schema.Struct<{
    yawRadians: Schema.filter<typeof Schema.Number>;
    pitchRadians: Schema.filter<typeof Schema.Number>;
}>;
```

### Orientation  `type`

```ts
type Orientation = typeof Orientation.Type;
```

### PROTOCOL_VERSION  `const`

```ts
const PROTOCOL_VERSION = 1;
```

### Ping  `const`

```ts
const Ping: Schema.TaggedStruct<"Ping", {
    nonce: Schema.filter<typeof Schema.Number>;
}>;
```

### Ping  `type`

```ts
type Ping = typeof Ping.Type;
```

### PlayerId  `const`

```ts
const PlayerId: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
```

### PlayerId  `type`

```ts
type PlayerId = typeof PlayerId.Type;
```

### PlayerJoin  `const`

```ts
const PlayerJoin: Schema.TaggedStruct<"PlayerJoin", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    name: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerName">;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
}>;
```

### PlayerJoin  `type`

```ts
type PlayerJoin = typeof PlayerJoin.Type;
```

### PlayerLeave  `const`

```ts
const PlayerLeave: Schema.TaggedStruct<"PlayerLeave", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
}>;
```

### PlayerLeave  `type`

```ts
type PlayerLeave = typeof PlayerLeave.Type;
```

### PlayerMove  `const`

```ts
const PlayerMove: Schema.TaggedStruct<"PlayerMove", {
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    world: Schema.optional<Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">>;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
    facing: Schema.Struct<{
        yawRadians: Schema.filter<typeof Schema.Number>;
        pitchRadians: Schema.filter<typeof Schema.Number>;
    }>;
}>;
```

### PlayerMove  `type`

```ts
type PlayerMove = typeof PlayerMove.Type;
```

### PlayerName  `const`

```ts
const PlayerName: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerName">;
```

### PlayerName  `type`

```ts
type PlayerName = typeof PlayerName.Type;
```

### PlayerSnapshot  `const`

```ts
const PlayerSnapshot: Schema.Struct<{
    player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
    name: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerName">;
    world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
    at: Schema.Struct<{
        x: Schema.filter<typeof Schema.Number>;
        y: Schema.filter<typeof Schema.Number>;
        z: Schema.filter<typeof Schema.Number>;
    }>;
    facing: Schema.Struct<{
        yawRadians: Schema.filter<typeof Schema.Number>;
        pitchRadians: Schema.filter<typeof Schema.Number>;
    }>;
}>;
```

### PlayerSnapshot  `type`

```ts
type PlayerSnapshot = typeof PlayerSnapshot.Type;
```

### Pong  `const`

```ts
const Pong: Schema.TaggedStruct<"Pong", {
    nonce: Schema.filter<typeof Schema.Number>;
}>;
```

### Pong  `type`

```ts
type Pong = typeof Pong.Type;
```

### ProtocolError  `class`

```ts
class ProtocolError extends ProtocolError_base<{
    readonly reason: ProtocolErrorReason;
    readonly detail: string;
}> {
}
```

### ProtocolErrorReason  `type`

```ts
type ProtocolErrorReason = 'malformed-frame' | 'unsupported-protocol-version' | 'unencodable-message';
```

### TransportError  `class`

```ts
class TransportError extends TransportError_base<{
    readonly reason: TransportErrorReason;
    readonly detail: string;
}> {
}
```

### TransportErrorReason  `type`

```ts
type TransportErrorReason = 'not-connected' | 'send-failed' | 'closed';
```

### TransportPort  `class`

```ts
class TransportPort extends TransportPort_base {
}
```

### TransportService  `type`

```ts
type TransportService = {
    readonly send: (frame: WireText) => Effect.Effect<void, TransportError>;
    readonly inbound: Queue.Dequeue<WireText>;
};
```

### UPSTREAM_STAGE_IDS  `const`

```ts
const UPSTREAM_STAGE_IDS: {
    readonly simPhysics: StageId;
};
```

### Vec3  `const`

```ts
const Vec3: Schema.Struct<{
    x: Schema.filter<typeof Schema.Number>;
    y: Schema.filter<typeof Schema.Number>;
    z: Schema.filter<typeof Schema.Number>;
}>;
```

### Vec3  `type`

```ts
type Vec3 = typeof Vec3.Type;
```

### WireText  `type`

```ts
type WireText = string;
```

### WorldId  `const`

```ts
const WorldId: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
```

### WorldId  `type`

```ts
type WorldId = typeof WorldId.Type;
```

### WorldInfo  `const`

```ts
const WorldInfo: Schema.TaggedStruct<"WorldInfo", {
    world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
    seed: Schema.filter<typeof Schema.Number>;
}>;
```

### WorldInfo  `type`

```ts
type WorldInfo = typeof WorldInfo.Type;
```

### WorldSnapshot  `const`

```ts
const WorldSnapshot: Schema.TaggedStruct<"WorldSnapshot", {
    world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
    seed: Schema.filter<typeof Schema.Number>;
    revision: Schema.filter<Schema.filter<typeof Schema.Number>>;
    players: Schema.Array$<Schema.Struct<{
        player: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerId">;
        name: Schema.brand<Schema.filter<typeof Schema.String>, "PlayerName">;
        world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
        at: Schema.Struct<{
            x: Schema.filter<typeof Schema.Number>;
            y: Schema.filter<typeof Schema.Number>;
            z: Schema.filter<typeof Schema.Number>;
        }>;
        facing: Schema.Struct<{
            yawRadians: Schema.filter<typeof Schema.Number>;
            pitchRadians: Schema.filter<typeof Schema.Number>;
        }>;
    }>>;
    blocks: Schema.Array$<Schema.Struct<{
        world: Schema.brand<Schema.filter<typeof Schema.String>, "WorldId">;
        at: Schema.Struct<{
            x: Schema.filter<typeof Schema.Number>;
            y: Schema.filter<typeof Schema.Number>;
            z: Schema.filter<typeof Schema.Number>;
        }>;
        block: Schema.NullOr<Schema.filter<typeof Schema.String>>;
    }>>;
}>;
```

### WorldSnapshot  `type`

```ts
type WorldSnapshot = typeof WorldSnapshot.Type;
```

### canSend  `const`

```ts
const canSend: (state: ConnectionState) => boolean;
```

### decodeFrame  `const`

```ts
const decodeFrame: (text: WireText) => Either.Either<NetworkMessage, ProtocolError>;
```

### disconnectedTransport  `const`

```ts
const disconnectedTransport: Effect.Effect<TransportService>;
```

### encodeFrame  `const`

```ts
const encodeFrame: (message: NetworkMessage) => Either.Either<WireText, ProtocolError>;
```

### encodeFrameAsVersion  `const`

```ts
const encodeFrameAsVersion: (protocolVersion: number, message: NetworkMessage) => Either.Either<WireText, ProtocolError>;
```

### initialConnectionState  `const`

```ts
const initialConnectionState: ConnectionState;
```

### isSettled  `const`

```ts
const isSettled: (state: ConnectionState) => boolean;
```

### makeLoopbackPair  `const`

```ts
const makeLoopbackPair: Effect.Effect<readonly [TransportService, TransportService]>;
```

### makeMultiplayerFrameState  `const`

```ts
const makeMultiplayerFrameState: Effect.Effect<MultiplayerFrameState>;
```

### makeMultiplayerHost  `const`

```ts
const makeMultiplayerHost: Effect.Effect<MultiplayerHost, never, TransportPort>;
```

### makeMultiplayerStages  `const`

```ts
const makeMultiplayerStages: Effect.Effect<ReadonlyArray<StageRegistration>, never, TransportPort>;
```

### makeMultiplayerStagesForPreview  `const`

```ts
const makeMultiplayerStagesForPreview: Effect.Effect<{
    readonly state: MultiplayerFrameState;
    readonly stages: ReadonlyArray<StageRegistration>;
}, never, TransportPort>;
```

### multiplayerModule  `const`

```ts
const multiplayerModule: GameModule<never, never, never, TransportPort>;
```

### multiplayerStages  `const`

```ts
const multiplayerStages: (state: MultiplayerFrameState, transport: TransportService) => ReadonlyArray<StageRegistration>;
```

### receiveMessage  `const`

```ts
const receiveMessage: Effect.Effect<NetworkMessage, ProtocolError, TransportPort>;
```

### runTransitions  `const`

```ts
const runTransitions: (from: ConnectionState, events: ReadonlyArray<ConnectionEvent>) => {
    readonly state: ConnectionState;
    readonly rejectedAt: number | undefined;
};
```

### sendMessage  `const`

```ts
const sendMessage: (message: NetworkMessage) => Effect.Effect<void, ProtocolError | TransportError, TransportPort>;
```

### transition  `const`

```ts
const transition: (state: ConnectionState, event: ConnectionEvent) => ConnectionState | undefined;
```

## Supporting declarations

Not exported from the barrel, but named by the signatures above, so a
consumer is exposed to them. `Context.Tag` service classes emit their real
type onto one of these.

### DeltaTimeSecs  `const`

```ts
const DeltaTimeSecs: Brand.Brand.Constructor<DeltaTimeSecs>;
```

### DeltaTimeSecs  `type`

```ts
type DeltaTimeSecs = number & Brand.Brand<'DeltaTimeSecs'>;
```

### FrameServices  `type`

```ts
type FrameServices = never;
```

### GameModule  `interface`

```ts
interface GameModule<ROut, E, RIn, RRegister = never> {
    readonly layers: Layer.Layer<ROut, E, RIn>;
    readonly frameStages: Effect.Effect<ReadonlyArray<StageRegistration>, never, RRegister>;
}
```

### ProtocolError_base  `const`

```ts
const ProtocolError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ProtocolError";
} & Readonly<A>;
```

### StageId  `const`

```ts
const StageId: Brand.Brand.Constructor<StageId>;
```

### StageId  `type`

```ts
type StageId = string & Brand.Brand<'StageId'>;
```

### StageRegistration  `interface`

```ts
interface StageRegistration {
    readonly id: StageId;
    readonly after?: ReadonlyArray<StageId>;
    readonly run: (dt: DeltaTimeSecs) => Effect.Effect<void, never, FrameServices>;
}
```

### TransportError_base  `const`

```ts
const TransportError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "TransportError";
} & Readonly<A>;
```

### TransportPort_base  `const`

```ts
const TransportPort_base: Context.TagClass<TransportPort, "@nerima-games/mx-multiplayer/TransportPort", TransportService>;
```
