# Signed agent mesh receipts

Receipt export sends signed records of agent activity to a private Nostr relay. Export is off by default. A relay acknowledgement confirms storage at that relay; it does not confirm that another agent received or completed the work. Output content stays in your environment, while receipts carry references to captured output.

Enable export with your private relay's WebSocket URL:

```sh
t3 mesh-export enable wss://relay.example
```

Each enable starts a new capture epoch at the current activity watermark. Earlier activity is not backfilled, and retained receipts from previous epochs stay paused. Save the epoch ID printed by the command or find it with:

```sh
t3 mesh-export status
```

Status lists each retained epoch's publication permission and pending and rejected receipt counts, including when export is disabled.

To pause capture and publication for all epochs:

```sh
t3 mesh-export disable
```

Pending receipts remain stored. Enabling export again starts a new epoch without automatically sending those older receipts. To explicitly authorize a paused epoch to publish, enable export to its original relay, then run:

```sh
t3 mesh-export resume <epoch-id>
```

Resume requires active export and the same relay URL used by that epoch. Changing the relay URL does not authorize transferring previously retained receipts to the new destination. Disabling export pauses resumed epochs too.

To permanently remove a paused epoch's publication permission:

```sh
t3 mesh-export discard <epoch-id>
```

Discard retains stored receipts and output artifacts. A discarded epoch cannot be resumed. To discard an active epoch, disable export first.

These commands apply to the environment on the machine where you run them. Use `--base-dir <directory>` to select a different ConvergeOS data directory.
