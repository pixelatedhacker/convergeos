# Bot computers

Bot Computer is a host-local Docker lifecycle attached to an existing active Bot thread. The
canonical key is the Bot `threadId` plus the server environment ID. It does not create another
agent identity, transcript, scheduler, event aggregate, or projection.

## State and authorization

`BotComputerState` is one discriminated union: unavailable, absent, suspended, running, or failed.
Every answer is derived from Docker inspection. Container existence and running status are never
persisted separately. Running and suspended states include the network policy read from a Docker
label. The server rejects inactive or missing threads, threads without an active Bot profile, and
Bots whose worktree is absent or resolves to the project's shared checkout.

The server advertises the capability on Linux and macOS. Docker itself may still be unavailable;
inspection then reports that explicitly. Viewer URLs are host-local only and always use a
loopback-published ephemeral port.

## Lifecycle

- `inspect` reads Docker and changes nothing.
- `start` and `resume` converge to a running container. A missing image is built lazily from the
  repository-owned Dockerfile, stale specs are recreated, and repeated calls are no-ops once the
  requested spec is running.
- `suspend` stops compute while retaining the container and named Chromium profile volume.
- `destroy` removes the owned container and profile volume. Missing resources count as success.
- `reset` destroys those resources and immediately converges to a clean running computer.

Lifecycle and computer-control calls are serialized inside the service. Concurrent requests cannot
race container creation, container removal, input delivery, or screenshot cleanup.
Deterministic names use a SHA-256 digest of length-framed environment and thread IDs; raw IDs are
not embedded in Docker resource names. Ownership, spec version, and network policy are labels. A
same-named resource without the expected ownership label fails closed.

## Agent controls

The ConvergeOS MCP server exposes `computer_status`, `computer_snapshot`, `computer_click`,
`computer_type`, `computer_press`, and `computer_scroll` to the Bot's provider session. Each tool
uses the authenticated invocation thread. The caller cannot name another Bot. The server checks
that the thread is still an active Bot, still owns an isolated worktree, and still owns a running
container before it runs a command.

Control commands use fixed executable and argument shapes. No tool exposes shell execution or an
arbitrary container command. Text input is one literal argument. Key input accepts only validated
X11 key names and chords. Screenshots have fixed capture and cleanup paths, an 8 MB decoded limit,
and PNG signature and dimension checks before the MCP server returns image content.

## Security boundary

V1 requires an explicit `networkAccess: "outbound"` on start, resume, and reset. Docker bridge
egress is never granted merely by omitting a policy. The container receives no Docker socket, home
mount, or ambient credential environment. Its only persistent mounts are the Bot worktree and a
dedicated Chromium profile volume. Because the worktree is mounted, secrets stored inside that
worktree remain in scope.

The container runs as UID/GID 1000 with a read-only root, all capabilities dropped,
`no-new-privileges`, bounded CPU, memory, PIDs, and shared memory, and explicitly owned tmpfs
runtime directories. The bundled Debian image contains Xvfb, Openbox, Chromium, xterm, PCManFM,
x11vnc, and noVNC/websockify on port 6080. x11vnc is loopback-only inside the container, and Docker
publishes noVNC on host loopback.

This is container isolation, not containment for hostile code. A later remote-viewer design must
add an authenticated server proxy or tunnel; it must not rewrite `127.0.0.1` as if it named the
client device.
