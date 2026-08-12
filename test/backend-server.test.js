const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const port = 4199;
async function api(command, args = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error);
  return body.result;
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('backend did not start');
}

test('React backend provides workspace files and streamed terminal events', async t => {
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  t.after(() => child.kill());
  await waitForServer();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-web-'));
  fs.writeFileSync(path.join(workspace, 'hello.ts'), 'export const hello = true;');
  assert.equal(await api('open_workspace', { path: workspace }), fs.realpathSync(workspace));
  assert.ok((await api('list_workspace', { workspace })).some(file => file.path === 'hello.ts'));
  assert.match(await api('read_workspace_file', { path: 'hello.ts' }), /hello/);
  await api('write_workspace_file', { path: 'hello.ts', content: 'export const hello = "saved";' });
  assert.match(fs.readFileSync(path.join(workspace, 'hello.ts'), 'utf8'), /saved/);
  await assert.rejects(() => api('read_workspace_file', { path: '../outside.txt' }), /escapes|relative/);

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise(resolve => socket.once('open', resolve));
  const id = await api('run_command', { command: `node -e "console.log('stream-ok')"` });
  const messages = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('terminal event timeout')), 8000);
    socket.on('message', raw => {
      const event = JSON.parse(raw);
      if (event.type === 'agent-event' && event.payload.agentId === id) {
        messages.push(event.payload.text);
        if (event.payload.kind === 'exit') { clearTimeout(timer); resolve(); }
      }
    });
  });
  socket.close();
  assert.ok(messages.some(line => line.includes('stream-ok')));
});
