# Local development

Run the code in this checkout without disturbing an installed `opencode`.

## Setup

```sh
bun install
```

The repo pins `packageManager: bun@1.4.2`; the pre-push hook rejects older Bun.

## Launcher

`bin/opencode-local` runs the V2 CLI/TUI from source. The dev entry must run with `CWD=packages/cli` for workspace module
resolution, so the script cd's there and passes your original directory as the CLI's `[directory]` positional. It uses the
local/dev channel (`service-local.json`), so it does not touch the installed `opencode` or its background service.

Install it on PATH once:

```sh
ln -sfn "$PWD/bin/opencode-local" ~/.local/bin/opencode-local
```

Then use `opencode-local` anywhere. `opencode-local --version` prints `vlocal`.

For testing against the currently running installed server and live sessions, use `bun run dev:live` from the repo root
instead (per `packages/cli` guidance).
