import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const packageName = manifest.name;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const typeScriptCompiler = join(root, "node_modules", "typescript", "bin", "tsc");

const commandLabel = (command, args) => command + " " + args.join(" ");

// The literal npm placeholder, built by concatenation so it never appears as
// `${...}` inside a plain string literal (oxlint's no-template-curly-in-string
// would otherwise read it as a forgotten template literal). npm — not this
// script — expands this from the environment at install time.
const NPM_AUTH_TOKEN_PLACEHOLDER = ["$", "{NODE_AUTH_TOKEN}"].join("");

const run = (command, args, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, ...options } = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    ...options,
  });
  if (result.error) {
    throw new Error(commandLabel(command, args) + " failed: " + result.error.message);
  }
  if (result.signal) {
    throw new Error(commandLabel(command, args) + " terminated by " + result.signal);
  }
  if (result.status !== 0) {
    throw new Error(commandLabel(command, args) + " exited with status " + result.status);
  }
  return result;
};

const capture = (command, args, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, ...options } = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    ...options,
  });
  if (result.error) {
    throw new Error(commandLabel(command, args) + " failed: " + result.error.message);
  }
  if (result.signal) {
    throw new Error(commandLabel(command, args) + " terminated by " + result.signal);
  }
  if (result.status !== 0) {
    throw new Error(
      commandLabel(command, args) +
        " exited with status " +
        result.status +
        "\n" +
        (result.stdout ?? "") +
        (result.stderr ?? ""),
    );
  }
  return result.stdout;
};

// mx-multiplayer declares no `exports` subpaths (docs/public-api.md: the barrel
// `src/index.ts` is the whole contract) — unlike mc-kernel's per-domain-module
// exports map, there is nothing here to diff against source entry points. The
// checks below verify only the root entry.
const exportEntries = Object.entries(manifest.exports ?? {});
if (exportEntries.length === 0) {
  throw new Error("package.json must declare at least one export");
}
if (exportEntries.length !== 1 || exportEntries[0][0] !== ".") {
  throw new Error(
    "mx-multiplayer's package.json is expected to declare exactly the root export " +
      '(".") — docs/public-api.md declares no subpath contract. If a subpath was ' +
      "just added, update this script's assumption.",
  );
}

const targetPaths = new Set();
for (const [subpath, target] of exportEntries) {
  if (typeof target !== "object" || target === null) {
    throw new Error(`Unsupported export declaration for ${subpath}`);
  }
  for (const field of ["types", "import", "default"]) {
    if (typeof target[field] === "string") {
      targetPaths.add(target[field]);
    }
  }
}
if (targetPaths.size === 0) {
  throw new Error("package.json exports do not contain any target paths");
}

const archiveEntryFor = (targetPath) => `package/${targetPath.replace(/^\.\//, "")}`;

const workspace = await mkdtemp(join(tmpdir(), "mx-multiplayer-package-"));
const packDirectory = join(workspace, "pack");
const consumerDirectory = join(workspace, "consumer");
await mkdir(packDirectory);
await mkdir(consumerDirectory);

try {
  run("pnpm", ["pack", "--pack-destination", packDirectory], { timeoutMs: 60_000 });

  const archives = (await readdir(packDirectory)).filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected exactly one package archive, found ${archives.length}`);
  }

  const archivePath = join(packDirectory, archives[0]);
  const archiveStat = await stat(archivePath);
  if (archiveStat.size === 0) {
    throw new Error("Package archive is empty");
  }

  const archiveEntries = new Set(
    capture("tar", ["-tzf", archivePath], { cwd: root, timeoutMs: 30_000 }).trim().split("\n").filter(Boolean),
  );
  for (const targetPath of targetPaths) {
    const archiveEntry = archiveEntryFor(targetPath);
    if (!archiveEntries.has(archiveEntry)) {
      throw new Error(`Package archive is missing export target ${archiveEntry}`);
    }
  }

  // Addendum 3 (2026-08-30 14:15 JST): the consumer install below resolves
  // @nerima-games/mc-sim from GitHub Packages, which needs an auth token even
  // for a public read. `${NODE_AUTH_TOKEN}` is the literal npm placeholder —
  // npm expands it from the environment at install time; the token itself is
  // never written to disk.
  await writeFile(
    join(consumerDirectory, ".npmrc"),
    "@nerima-games:registry=https://npm.pkg.github.com\n" +
      "//npm.pkg.github.com/:_authToken=" +
      NPM_AUTH_TOKEN_PLACEHOLDER +
      "\n",
  );
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify(
      {
        name: "mx-multiplayer-package-consumer",
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
  );
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archivePath], {
    cwd: consumerDirectory,
    timeoutMs: 180_000,
    env: { ...process.env, NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN ?? "" },
  });

  // Runtime probe: import the published root entry and exercise a slice of
  // docs/public-api.md's contract end to end — a roundtripped frame, a
  // connection-state transition, and an actual loopback send/receive (which
  // forces the encode/decode path per domain/transport.ts's own header note).
  const probe = `
    const packageName = ${JSON.stringify(packageName)};
    const mod = await import(packageName);

    const expectedExports = ${JSON.stringify([
      "PROTOCOL_VERSION",
      "PlayerId",
      "PlayerName",
      "WorldId",
      "Vec3",
      "BlockPos",
      "Orientation",
      "NetworkMessage",
      "MESSAGE_TAGS",
      "Frame",
      "encodeFrame",
      "encodeFrameAsVersion",
      "decodeFrame",
      "ProtocolError",
      "TransportError",
      "initialConnectionState",
      "transition",
      "runTransitions",
      "canSend",
      "isSettled",
      "AuthoritativeRevisionTracker",
      "TransportPort",
      "connectionGatedTransport",
      "sendMessage",
      "receiveMessage",
      "makeLoopbackPair",
      "LoopbackTransportLayer",
      "disconnectedTransport",
      "SnapshotInterpolator",
      "MULTIPLAYER_STAGE_IDS",
      "UPSTREAM_STAGE_IDS",
      "multiplayerModule",
      "makeMultiplayerStages",
    ])};
    const missing = expectedExports.filter((name) => !(name in mod));
    if (missing.length > 0) {
      throw new Error('Published package is missing exports: ' + missing.join(', '));
    }

    const { Effect } = await import('effect');
    const player = mod.PlayerId.make('package-probe-player');
    const message = mod.PlayerLeave.make({ player });
    const encoded = mod.encodeFrame(message);
    if (encoded._tag !== 'Right') {
      throw new Error('encodeFrame rejected a message this build should speak');
    }
    const decoded = mod.decodeFrame(encoded.right);
    if (decoded._tag !== 'Right' || JSON.stringify(decoded.right) !== JSON.stringify(message)) {
      throw new Error('decodeFrame(encodeFrame(m)) did not round-trip');
    }

    const connecting = mod.transition(mod.initialConnectionState, { _tag: 'ConnectRequested' });
    if (connecting === undefined || connecting._tag !== 'Connecting') {
      throw new Error('transition(Disconnected, ConnectRequested) did not reach Connecting');
    }
    const rejected = mod.transition(mod.initialConnectionState, { _tag: 'HandshakeFailed' });
    if (rejected !== undefined) {
      throw new Error('transition accepted an event that should be illegal from Disconnected');
    }

    const loopbackProgram = Effect.gen(function* () {
      const [client, server] = yield* mod.makeLoopbackPair;
      yield* mod.sendMessage(message).pipe(Effect.provide(mod.LoopbackTransportLayer(client)));
      return yield* mod.receiveMessage.pipe(Effect.provide(mod.LoopbackTransportLayer(server)));
    });
    const received = await Effect.runPromise(loopbackProgram);
    if (JSON.stringify(received) !== JSON.stringify(message)) {
      throw new Error('Loopback transport did not deliver what crossed the queue as protocol text');
    }

    if (mod.MULTIPLAYER_STAGE_IDS.inbound !== 'multiplayer:inbound' ||
        mod.MULTIPLAYER_STAGE_IDS.outbound !== 'multiplayer:outbound') {
      throw new Error('MULTIPLAYER_STAGE_IDS did not carry the documented stage ids');
    }

    console.log('verified ' + packageName + ' exports: ' + expectedExports.join(', '));
  `;
  run("node", ["--input-type=module", "--eval", probe], {
    cwd: consumerDirectory,
    timeoutMs: 30_000,
    env: { ...process.env, NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN ?? "" },
  });

  const typeConsumerSource = `
import {
  PlayerId,
  PlayerLeave,
  encodeFrame,
  decodeFrame,
  initialConnectionState,
  transition,
  PROTOCOL_VERSION,
  MULTIPLAYER_STAGE_IDS,
  type NetworkMessage,
  type ConnectionState,
} from ${JSON.stringify(packageName)}

const player: PlayerId = PlayerId.make('declaration-probe-player')
const message: NetworkMessage = PlayerLeave.make({ player })
const encoded = encodeFrame(message)
const nextState: ConnectionState | undefined = transition(initialConnectionState, { _tag: 'ConnectRequested' })

if (PROTOCOL_VERSION < 0) {
  throw new Error('Protocol version declaration consumer returned an invalid result')
}
if (MULTIPLAYER_STAGE_IDS.inbound.length === 0) {
  throw new Error('Stage id declaration consumer returned an invalid result')
}
void encoded
void decodeFrame
void nextState
`;
  if (typeConsumerSource.trim().length === 0) {
    throw new Error("TypeScript consumer source must not be empty");
  }
  await writeFile(join(consumerDirectory, "consumer.ts"), typeConsumerSource.trimStart());
  await writeFile(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    ) + "\n",
  );
  run(process.execPath, [typeScriptCompiler, "--project", join(consumerDirectory, "tsconfig.json"), "--pretty", "false"], {
    cwd: consumerDirectory,
    timeoutMs: 30_000,
  });
  console.log(`verified ${packageName} declaration consumer typecheck`);

  console.log(`verified package archive ${relative(root, archivePath)}`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
