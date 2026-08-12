const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LiveCoordinator } = require('../live-coordinator');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-live-'));
  const events = [];
  return { root, events, coordinator: new LiveCoordinator({ root, dataDir: path.join(root, '.relay'), emit: (type, payload) => events.push({ type, payload }) }) };
}

test('real agents coordinate dependencies and receive immediate unblock events', () => {
  const { coordinator, events } = setup();
  coordinator.registerAgent({ id: 'agent-auth', name: 'Auth agent', provider: 'codex', ownerId: 'maya' });
  coordinator.registerAgent({ id: 'agent-oauth', name: 'OAuth agent', provider: 'opencode', ownerId: 'leo' });
  const auth = coordinator.createTask({ title: 'Build authentication contract', createdBy: 'maya', assignee: 'agent-auth' });
  const oauth = coordinator.createTask({ title: 'Add Google OAuth', createdBy: 'leo', assignee: 'agent-oauth' });
  coordinator.addDependency(oauth.id, auth.id, 'agent-oauth');
  assert.equal(coordinator.state.tasks[oauth.id].status, 'waiting');
  coordinator.completeTask(auth.id, { actor: 'agent-auth', summary: 'AuthProvider is ready', files: ['src/auth/AuthProvider.ts'] });
  assert.equal(coordinator.state.tasks[oauth.id].status, 'assigned');
  assert.equal(coordinator.state.agents['agent-oauth'].status, 'ready');
  assert.ok(events.some(event => event.type === 'message' && event.payload.kind === 'unblocked'));
});

test('file ownership prevents conflicting agents and survives restart', () => {
  const { root, coordinator } = setup();
  coordinator.registerAgent({ id: 'agent-a', provider: 'codex' });
  coordinator.registerAgent({ id: 'agent-b', provider: 'claude' });
  assert.equal(coordinator.claimFile('agent-a', 'src/auth.ts').ok, true);
  assert.equal(coordinator.claimFile('agent-b', 'src/auth.ts').ok, false);
  const restored = new LiveCoordinator({ root, dataDir: path.join(root, '.relay') });
  assert.equal(restored.state.ownership['src/auth.ts'], 'agent-a');
  assert.equal(restored.state.agents['agent-b'].status, 'blocked');
});

test('human decisions block agents and resolution is delivered as a real message', () => {
  const { coordinator } = setup();
  coordinator.registerAgent({ id: 'agent-db', provider: 'codex' });
  const task = coordinator.createTask({ title: 'Choose database migration strategy', assignee: 'agent-db', createdBy: 'maya' });
  const decision = coordinator.requestDecision({ taskId: task.id, agentId: 'agent-db', title: 'Online or offline migration?', detail: 'This changes production availability.' });
  assert.equal(coordinator.state.agents['agent-db'].status, 'blocked');
  coordinator.resolveDecision(decision.id, 'approved', 'maya', 'Use an online migration.');
  assert.equal(coordinator.state.agents['agent-db'].status, 'ready');
  assert.ok(coordinator.state.messages.some(message => message.to === 'agent-db' && /online migration/i.test(message.text)));
});

test('team lead rejects cyclic dependencies', () => {
  const { coordinator } = setup();
  const a = coordinator.createTask({ title: 'A' });
  const b = coordinator.createTask({ title: 'B' });
  coordinator.addDependency(a.id, b.id);
  assert.throws(() => coordinator.addDependency(b.id, a.id), /cycle/);
});
