# Local development

Run the code in this checkout without disturbing an installed `opencode`.

## Setup

```sh
bun install
```

The repo pins `packageManager: bun@1.4.2`; the pre-push hook rejects older Bun.

## Launcher

`bin/opencode-local` runs the V2 CLI/TUI from source. The dev entry must run with `CWD=packages/cli` for workspace module
resolution, so the script cd's there and passes your original directory as the CLI's `[directory]` positional.

It always passes `--standalone`: the CLI chdirs into `[directory]` before resolving the server, so the _shared_ background
service would be spawned with your project's cwd, where Bun cannot find the repo's `jsxImportSource` tsconfig and falls back
to `react/jsx-dev-runtime`. A private standalone server is spawned from `CWD=packages/cli` instead. This also means it never
replaces the background service used by the installed `opencode`.

Install it on PATH once:

```sh
ln -sfn "$PWD/bin/opencode-local" ~/.local/bin/opencode-local
```

Then use `opencode-local` anywhere. `opencode-local --version` prints `vlocal`.

For testing against the currently running installed server and live sessions, use `bun run dev:live` from the repo root
instead (it connects to an existing server and spawns nothing).
