# dsh-focus-mode

An external [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) preset with persistent shell sessions, direct tool calls, and TypeScript program execution. No dsh source or frontend patches are required.

Compatibility: dsh `0.2.1-rc.3`, validated against upstream commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`. Node.js `>=24.9` is required. This repository extracts the 0.1.2 plugin implementation; its runtime sources and bundle declaration match that implementation.

## Install

Prepare the compatible host checkout as described under [development](#development), then build a package from this repository:

```sh
npm ci --ignore-scripts
DSH_SOURCE="$PWD/../deepseek-harness" npm run link:host
npm run build
mkdir -p dist
npm run pack:release
```

Install the generated archive in a development profile first:

```sh
dsh --profile focus-sandbox --from-default-profile web
dsh plugin --profile focus-sandbox add ./dist/dsh-focus-mode-0.1.2.tgz
dsh --profile focus-sandbox --dump-config
dsh --profile focus-sandbox
```

Choose **Focus mode** in a new session. Installation adds a preset without changing the current default. To remove it, finish sessions using that preset, then run `dsh plugin --profile focus-sandbox remove dsh-focus-mode`. A restart may be required when the profile does not support hot reload.

## Behavior

- `exec_command({cmd, session_id?, cwd?, run_in_background?})` opens or reuses an Agent-owned persistent shell. Working directory and environment survive successive calls. `cwd` applies only to new sessions.
- `write_stdin({session_id, chars?, run_in_background?, close?})` reads new output or sends input. A newline submits input; a standalone Ctrl-C interrupts. `close:true` closes the shell and releases its slot.
- `run_code` uses the upstream PTC executor. Available plugin tools enter both direct schemas and the program SDK through the host registry; the executor has no tool-name allowlist. Host scope, step admission, restrictions, approvals, guards, cancellation, and logging remain authoritative.
- Background jobs monitor a whole shell until it exits or closes. `job_kill` closes that shell. Each shell has at most one background monitor. Shell liveness or a settled send does **not** establish that an individual command finished.

The preset retains agent instructions, time context, compaction, skills, web tools, deliverables, plugin inspection/management, and workflows. Additional visible tools from Agent Teams, session search, worktrees, or terminal plugins are inherited automatically. Direct schemas plus the program SDK increase prompt size; PTC can keep intermediate results out of the conversation history.

## Configuration

The plugin defaults to four persistent shell sessions per Agent. Session count is configurable from 1 to 64. The upstream jobs registry has a separate concurrent-job limit. The [16-session/16-job example](examples/limits-16.patch.yml) overrides both:

```sh
dsh --profile focus-sandbox --patch ./examples/limits-16.patch.yml --dump-config
dsh --profile focus-sandbox --patch ./examples/limits-16.patch.yml
```

`--patch` applies to that launch. For a permanent override, merge the example's two rows into the profile's `cordis.patch.yml`, preserving other settings and existing fields on the `jobs` row.

In this dsh version, a profile patch replaces a matched row's **whole config**. The command tools are nested in a preset declaration, so the example restates `external-preset-focus-mode` and changes `persistent-shell → focus-commands → config.maxSessionsPerAgent`. A top-level `preset: focus-mode` / `id: focus-commands` patch is not supported. Keep a copied preset declaration aligned with future bundle upgrades.

| Command-tool option | Default | Allowed range |
| --- | --- | --- |
| `backendType` | `shell` | Registered terminal backend |
| `maxSessionsPerAgent` | 4 | 1–64 |
| `maxResultBytes` | 262144 | 256–16777216 bytes |
| `yieldMs` | 1000 | 0–60000 ms |
| `pollMs` | 50 | 1–10000 ms |
| `readLines` | 10000 | 1–100000 |

Result byte limits include metadata. Truncation retains the tail and reports possible loss; increase the read/retention settings and rerun a command when omitted output is required. Terminal send timeouts and scrollback retention belong to the `terminal-bash` / `terminal-pwsh` configuration.

## Development

The `0.2.1-rc.3` native/PTC executor packages used by this baseline are not published on npm. This repository therefore needs a prepared source checkout for both development builds and integration tests. It does not substitute the incompatible published alpha versions. `.npmrc` disables automatic peer installation; the host supplies those capabilities, while the lockfile pins the development tools and ordinary dependencies.

After preparing the host, run:

```sh
npm ci --ignore-scripts
DSH_SOURCE="$PWD/../deepseek-harness" npm run link:host
npm run typecheck
npm run build
npm pack --dry-run --ignore-scripts
```

Prepare a separate dsh source checkout at the compatibility commit. Follow that checkout's installation/build instructions, including its native addon prerequisites. The link script creates links only inside this repository's ignored `node_modules`; it does not install the plugin into the host or edit host files. Re-run it after `npm ci`. Do not use a production checkout as an editable test fixture.

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness
git -C ../deepseek-harness checkout 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
# Install dependencies and build host artifacts in ../deepseek-harness first.
DSH_SOURCE="$PWD/../deepseek-harness" npm test
```

`DSH_SOURCE` is explicit; there are no personal paths or vendored host sources. The configuration reads the host's source aliases and decorator transform, and generates a lazy fixture import map. It does not edit the host. The 24 existing tests cover real Loader/PTY/jobs behavior, dynamic tool registration and withdrawal, authorization, cancellation/cleanup, pagination, direct/PTC ordering and logs, Web/addon composition, and isolated directory/archive installation and removal. They use no model keys or real model requests.

Runtime code belongs in `src/`; host integration fixtures and expected output belong in `tests/`. See [plugin organization](docs/plugin-organization.md) for a layout that can grow to multiple plugins.

## Limitations

- Compatibility is pinned to one pre-stable host baseline; upgrades require revalidation.
- Shell sessions live in memory and do not survive a process restart. Exited sessions count toward the quota until closed. Agent or plugin teardown closes owned terminals.
- The scrollback interface lacks a monotonic byte cursor. Identical output replacing an entire retained window cannot always be distinguished; already discarded bytes cannot be recovered.
- The profile must provide the upstream Web host capabilities and a PTC runtime. This bundle does not launch a server or configure a model/network provider.
- Full browser UI, real providers, and Windows/macOS behavior were not covered by the Linux keyless suite. The preset name and description do not use the host's built-in preset translation table.

## License

[MIT](LICENSE). DeepSeek Harness is a separate upstream project; this is an independently maintained plugin.
