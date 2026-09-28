# Compatibility and preflight

Inspected 2026-09-28 on the actual bootstrap machine. No global configuration, Git identity, accounts, or global packages changed. Credential **provider names only** were inspected; values were never printed.

## Environment and chosen versions

| Item | Observed / selected |
|---|---|
| OS | Ubuntu 25.10, Linux x86_64, kernel 6.17.0-41-generic |
| Git | 2.51.0; existing author/committer identity resolves; empty repository initialized on `main` |
| Node | Initially absent from PATH. **24.21.0 LTS (Krypton)** installed under ignored `.local/node-v24.21.0-linux-x64` |
| Node archive SHA-256 | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`, checked against official SHASUMS256.txt over HTTPS |
| npm | **11.19.0**, bundled with Node; no global install |
| OpenCode | Installed **1.18.33**; SDK and custom-tool plugin pinned to **1.18.33** |
| SQLite | better-sqlite3 **13.0.3**, maintained synchronous driver, Node >=22; actual SQLite **3.53.4** |
| TypeScript / tests / schemas | **7.0.2** / Vitest **5.0.2** / Zod **4.6.5**, YAML **2.9.1**, Commander **15.0.0** |
| Rust | Default 1.92.0; stable **1.95.0** already installed and selected explicitly for template |
| Bevy | **0.19.1**, non-yanked; crate metadata MSRV **1.95.0** |
| Desktop | cc/c++/pkg-config present; X11 1.8.12, Xi 1.8.2, Xrandr 1.5.4, Xcursor 1.2.3, Xinerama 1.1.4, ALSA 1.2.14, udev 257, Wayland 1.24.0, xkbcommon 1.7.0. Vulkan pkg-config entry missing. DISPLAY/WAYLAND_DISPLAY set. Actual GPU/render test pending. |
| Models/credentials | No `model` or agent limit in effective global config. Existing credential entries: anthropic/openai. Server reports connected anthropic/opencode/openai. No external plugins/MCP configured. Default selection must be resolved without a provider fallback. Authentication presence is not proof a model call works. |

Activate local Node for this checkout:

```sh
export PATH="$PWD/.local/node-v24.21.0-linux-x64/bin:$PATH"
npm --prefix tools/harness ci
npm run build:harness
npm run test:harness
```

`scripts/preflight.py --node` reproduces the local installation on Linux x86_64. Other platforms should install the exact official runtime for their platform. No Node binary is committed.

## Official sources inspected

- <https://nodejs.org/en/about/previous-releases>, <https://nodejs.org/dist/index.json>, version-specific archive/checksums at <https://nodejs.org/dist/v24.21.0/>. Node 24 is LTS; Node 26 is Current.
- <https://opencode.ai/docs/sdk/>, <https://opencode.ai/docs/server/>, <https://opencode.ai/docs/agents/>, <https://opencode.ai/docs/custom-tools/>, <https://opencode.ai/docs/config/>, <https://opencode.ai/docs/permissions/>, <https://opencode.ai/docs/commands/>, <https://opencode.ai/config.json>.
- Installed `@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts`, `types.gen.d.ts`, and `@opencode-ai/plugin/dist/tool.d.ts`. The default SDK export is older than its `/v2` generated client. Use **`@opencode-ai/sdk/v2`**, flat parameter objects, `sessionID`, `directory`, `session.promptAsync`, `permission.list/reply`, and explicit SDK error handling. Do not copy the docs' outdated `path: { id }` example into this adapter.
- Installed server `/doc`: SHA-256 `46db986090aae41846cd6dbe16225a1d883f0bbcb4c48814008d3f6ce140aa5c`. Runtime copy at `tools/.local/probe/openapi.json` (ignored). API probe source: `tools/harness/scripts/probe.mjs`.
- <https://git-scm.com/docs/git-worktree>; use explicit commits, separate branches, NUL-delimited path output; never force a user's checked-out branch.
- <https://bevy.org/learn/quick-start/getting-started/setup/>, <https://docs.rs/bevy/0.19.1/bevy/>, <https://crates.io/api/v1/crates/bevy/0.19.1>. Defaults include rendering/audio; template must use explicit features and headless default members. No nightly optimizations.
- npm registry metadata checked for all direct dependencies; manifests pin exact versions and package-lock.json contains transitive integrity hashes.

## No-spend compatibility probe

```sh
npm --prefix tools/harness run build
node tools/harness/scripts/probe.mjs .local/api-probe
```

Actual result: owned loopback server reported 1.18.33 and correct directory; unauthenticated request returned **401**; async context-only prompt returned **204**; persisted message ID and session directory matched; permission list returned an array; nonexistent session returned **404** with SDK error object; session was idle. **Zero model calls.** Session deleted and owned process terminated in `finally`. Probe report is in its output directory. Live tool/permission behavior requires the bounded live demo in Phase C.

## Remaining prerequisites

- Verify selected effective model before live spend; no fallback provider is authorized.
- Desktop rendering and screenshots remain unverified until an actual finite graphical run succeeds.
- CI workflow execution is not local evidence and requires an operator's separate CI environment.
