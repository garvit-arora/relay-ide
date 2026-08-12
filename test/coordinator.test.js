const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkspace } = require('../coordinator');

test('oauth waits for auth contract then unblocks and writes real files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const events = [];
  const workspace = createWorkspace(root, (type,payload) => events.push({type,payload}));
  workspace.runScenario();
  const auth = workspace.state.tasks.find(t => t.title === 'Build authentication');
  const oauth = workspace.state.tasks.find(t => t.title === 'Add Google OAuth');
  assert.equal(auth.status, 'done');
  assert.equal(oauth.status, 'done');
  assert.deepEqual(oauth.dependsOn, [auth.id]);
  assert.match(fs.readFileSync(path.join(root, 'src/auth/AuthProvider.ts'), 'utf8'), /interface AuthProvider/);
  assert.match(fs.readFileSync(path.join(root, 'src/auth/GoogleOAuthProvider.ts'), 'utf8'), /implements AuthProvider/);
  assert.ok(events.some(e => e.type === 'message' && /What authentication interface/.test(e.payload.text)));
  assert.ok(events.some(e => e.type === 'test.result' && e.payload.passed));
});

test('file claims prevent conflicting writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const events = [];
  const workspace = createWorkspace(root, (type,payload) => events.push({type,payload}));
  assert.equal(workspace.claimFile('agent-maya', 'src/shared.ts'), true);
  assert.equal(workspace.writeFile('agent-leo', 'src/shared.ts', 'bad', 'collision'), false);
  assert.equal(fs.existsSync(path.join(root, 'src/shared.ts')), false);
  assert.ok(events.some(e => e.type === 'file.conflict'));
});

test('risky work pauses for explicit human approval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const workspace = createWorkspace(root);
  const task = workspace.createTask({ title: 'Migrate production database', assignee: 'maya', createdBy: 'maya' });
  assert.equal(task.status, 'waiting');
  assert.equal(fs.existsSync(path.join(root, 'src/features/migrate-production-database.ts')), false);
  const decision = workspace.state.decisions.find(d => d.taskId === task.id);
  workspace.action('decision.resolve', { id: decision.id, status: 'approved' }, 'maya');
  assert.equal(task.status, 'done');
  assert.equal(fs.existsSync(path.join(root, 'src/features/migrate-production-database.ts')), true);
});
