# Upstream IDE foundations

Relay is being migrated from a lightly patched Code-OSS harness to a maintained fork-based architecture. Upstream sources are pinned as Git submodules so builds remain reproducible and upstream code is not copied without attribution.

## Pinned sources

| Path | Upstream | Revision | Intended use |
|---|---|---:|---|
| `vendor/void` | `voideditor/void` | `b3166e7ef2aefbdfeb139445fdf248a561b85d4d` | Primary VS Code workbench, native React sidebar, streamed edits, model/edit services |
| `vendor/pearai` | `trypear/pearai-app` | `d930f0233c14668df9f85c6a78a81828f4251194` | Product/build reference for a VS Code AI distribution |
| `vendor/pearai-continue` | `trypear/pearai-submodule` | `51eceef62a90c29f712b3a9607ea70a9dca657e9` | Provider adapters, context/indexing, model configuration patterns |
| `vendor/pearai-roo` | `trypear/PearAI-Roo-Code` | `0b6df736c9b2799c38b9ee629668407521a7bdda` | Agent tool-loop, approvals, terminal/browser task UX patterns |
| `vendor/vscode` | `microsoft/vscode` | existing pin | Known-good fallback until the Void migration passes parity checks |

## Integration decision

Void is the primary workbench candidate because its fork contains native workbench services for streamed code edits and a React-based AI sidebar. PearAI's app fork is older and delegates its main AI behavior to separate extensions, so Relay will selectively adapt those extension architectures rather than nesting the entire PearAI workbench inside Void.

Relay keeps ownership of:

- persistent WebSocket collaboration and shared project state;
- users, rooms, agents, tasks, dependencies, file claims, decisions, and approvals;
- the native Relay Code identity and multi-agent coordination protocol;
- Tauri packaging during the migration, with the current Code-OSS server retained as a fallback.

## Licensing and attribution

Do not remove upstream license, copyright, or attribution files. Each submodule retains its original history and license. Any adapted source must keep the applicable notices and be documented in `ThirdPartyNotices` when it is copied into Relay-owned code.

## Checkout

```powershell
git submodule update --init --recursive
```

The current PearAI app commit declares two nested submodules in `.gitmodules` but does not contain their gitlink entries. Relay therefore pins those repositories explicitly at `vendor/pearai-continue` and `vendor/pearai-roo`.
