# Worktree inventory

A worktree is still a Git checkout a thread can run in. The environment now
also exposes a live inventory of every checkout Git has registered for a
project repository — including trees no thread claims.

The inventory is not a projection table. Git already has the list
(`worktree list --porcelain`). Threads already have claims (`worktreePath`).
The server merges those on read. Persisting a copy would rot.

## Domain

A listed worktree has a path, whether it is the repository's primary checkout,
HEAD, branch or detached state, and whether Git still has a directory there.
Residue on that checkout is part of the same read:

- **dirty files** — `git status --porcelain=v1` in that tree
- **unique commits** — commits reachable from that tree's HEAD that are not
  reachable from any other registered worktree HEAD, and not reachable from any
  named ref except this tree's current branch
- **disk bytes** — size of the working tree, skipping `.git` so the primary
  checkout is not charged for the shared object database

Inspecting one worktree returns the dirty paths (with porcelain XY codes) and
unique commit SHAs with subjects. Lists carry counts only. File contents never
leave the environment on this path.

Missing or prunable trees stay in the list with zero residue so a stale Git
admin entry is visible.

## VCS seam

[`GitVcsDriver`][1] implements `listWorktrees` and `inspectWorktree`.
[`GitWorkflowService`][2] is the in-process caller: a non-repository cwd
returns an empty list; inspect of a path Git does not have registered fails.
Create and remove stay the existing `createWorktree` / `removeWorktree`
operations.

Inspect of an unregistered path is an error, not a listing of an arbitrary
directory.

Pages remain the durable published-result aggregate. Mesh artifacts remain
receipt blobs. Checkpoints remain hidden git refs. Residue on a checkout is
not a fourth blob store.

[1]: ../../apps/server/src/vcs/GitVcsDriver.ts
[2]: ../../apps/server/src/git/GitWorkflowService.ts
