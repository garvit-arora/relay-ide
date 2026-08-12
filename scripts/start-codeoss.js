const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const vscode = path.join(root, 'vendor', 'vscode');
const node = path.join(vscode, '.build', 'node', 'v24.18.1', 'win32-x64', 'node.exe');
const runtime = require('fs').existsSync(node) ? node : process.execPath;
const child = spawn(runtime, [
  'out/server-main.js', '--host', '127.0.0.1', '--port', '3001',
  '--without-connection-token', '--accept-server-license-terms', '--disable-telemetry',
  '--disable-workspace-trust', '--default-folder', root,
  '--extensions-dir', path.join(root, 'relay-extensions')
], { cwd: vscode, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1' } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));