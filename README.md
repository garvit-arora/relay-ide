# Relay Desktop IDE

Relay is now a **Tauri desktop application built around the upstream Code-OSS workbench**. It is not a standalone React/Monaco website.

## Architecture

```text
Tauri desktop window
  -> local Code-OSS web workbench (127.0.0.1:3001)
     -> real VS Code editor, explorer, extension host, Git, tasks, terminal
     -> Relay AI Team extension
  -> Relay coordination backend (127.0.0.1:4173)
     -> persistent WebSocket events
     -> agent processes (Codex, Claude Code, Azure, custom CLI)
     -> team chat, tasks, dependencies, file claims, approvals, shared memory
```

Upstream VS Code desktop is tightly coupled to Electron. Replacing Electron inside VS Code would be a large fork. Relay therefore uses the minimum-change route: Code-OSS's supported browser workbench and remote extension-host/server run locally, while Tauri owns the native desktop window and process lifecycle.

## Current vertical slice

## Live agent coordination

Relay now includes a durable coordination engine (`live-coordinator.js`) used by real agent processes. It persists tasks, dependencies, agent status, rooms, file claims, human decisions, engineering memory, and test results under the Relay application-data directory.

Every launched Codex, Claude Code, OpenCode, Azure, or custom agent receives the current team state plus a real coordination CLI. Agents can call:

```powershell
node scripts/relay-agent.js message.send --to agent-id --text "I need the auth contract"
node scripts/relay-agent.js file.claim --file src/auth/provider.ts
node scripts/relay-agent.js task.dependency --taskId task-id --dependencyId other-task-id
node scripts/relay-agent.js decision.request --taskId task-id --title "Choose migration mode" --detail "Online or offline?"
node scripts/relay-agent.js memory.create --title "Auth contract" --content "OAuth providers implement AuthProvider"
```

These calls update every connected IDE immediately over WebSockets. Completing a dependency sends a real unblock message and changes the waiting agent to `ready`. File claims reject conflicting agents, decisions pause agents for human input, and all state survives backend restarts.

The bundled **Relay Obsidian** theme, typography defaults, Chat with Agent panel, rooms, execution streams, and War Room make Code-OSS feel like a Relay product while retaining the genuine VS Code workbench.

- Real Code-OSS workspace with local file editing.
- Actual integrated terminal through VS Code/node-pty.
- Built-in Git and source control.
- Relay AI Team extension with agent execution streams, team chat, skills, onboarding, and War Room.
- Persistent WebSocket collaboration backend; no polling.
- Real coordinator behavior for task dependencies, file claims, handoffs, and human approvals.
- Codex CLI, Claude Code, Azure OpenAI/Codex configuration, and custom command providers.
- Provider secrets encrypted by the backend and stored outside workspace files.
- Tauri starts and stops the backend and Code-OSS processes with the app.
- First-run onboarding opens automatically inside the workbench.

## Development prerequisites

- Node.js 24
- Docker Desktop (used for reproducible Rust/Tauri source validation)
- Rust/MSVC/WebView2 for native Windows packaging

The checked-in `vendor/vscode` tree is the upstream Code-OSS source harness. Compile it before first launch:

```powershell
npm install
npm run codeoss:compile
npm run desktop:check
npm run dev
```

`npm run desktop:check` uses Docker Desktop and validates the Tauri Rust code against Linux WebKit/GTK libraries. A Windows `.exe`/`.msi` must still be linked on Windows because Tauri uses WebView2 and MSVC there.

## Useful commands

```powershell
npm test                 # coordination and backend integration tests
npm run backend          # Relay WebSocket/API backend only
npm run codeoss:server   # Code-OSS workbench only
npm run desktop:check    # cargo check inside Docker Desktop
npm run desktop:build    # build Windows Tauri installers on a permitted Windows host
```

## Runtime data

In development, Relay data lives in `.relay-data/`. Packaged builds use the operating system application-data directory. Azure keys and other provider secrets do not enter project files or browser storage.

## Packaging note

The Tauri bundle includes the Code-OSS runtime, built-in extensions, Relay extension, backend, Node runtime, and licenses. This favors a complete, local IDE over a small web wrapper. A release pipeline can later replace the development Code-OSS tree with the upstream minimized `vscode-reh-web` package to reduce installer size.