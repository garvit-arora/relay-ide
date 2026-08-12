const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const uid = (prefix) => `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
const now = () => new Date().toISOString();

const PEOPLE = [
  { id: 'maya', name: 'Maya Chen', initials: 'MC', color: '#ff9b73', role: 'Frontend' },
  { id: 'leo', name: 'Leo Martins', initials: 'LM', color: '#7dd3fc', role: 'Platform' },
];

function createWorkspace(root, emit = () => {}) {
  const state = {
    project: { id: 'relay', name: 'Relay Workspace', branch: 'main', health: 'passing' },
    people: PEOPLE.map((person, index) => ({
      ...person,
      online: false,
      agent: {
        id: `agent-${person.id}`,
        name: index ? 'Orbit' : 'Nova',
        status: 'idle',
        taskId: null,
        progress: 0,
        files: [],
      },
    })),
    tasks: [], messages: [], files: {}, ownership: {}, decisions: [], tests: [], activity: [],
  };

  const pushActivity = (type, text, actor = 'system') => {
    const item = { id: uid('activity'), type, text, actor, at: now() };
    state.activity.unshift(item);
    state.activity = state.activity.slice(0, 80);
    emit('activity', item);
    return item;
  };

  const message = (from, to, text, kind = 'agent') => {
    const item = { id: uid('msg'), from, to, text, kind, at: now() };
    state.messages.push(item);
    emit('message', item);
    return item;
  };

  const updateAgent = (agentId, patch) => {
    const person = state.people.find(p => p.agent.id === agentId);
    if (!person) return;
    Object.assign(person.agent, patch);
    emit('agent.updated', { agentId, patch });
  };

  const updateTask = (task, patch) => {
    Object.assign(task, patch, { updatedAt: now() });
    emit('task.updated', task);
  };

  const claimFile = (agentId, file) => {
    const owner = state.ownership[file];
    if (owner && owner !== agentId) {
      message('team-lead', agentId, `${file} is owned by ${owner}. I blocked the write to prevent a conflict.`, 'warning');
      updateAgent(agentId, { status: 'blocked' });
      emit('file.conflict', { file, owner, requestedBy: agentId });
      return false;
    }
    state.ownership[file] = agentId;
    const person = state.people.find(p => p.agent.id === agentId);
    if (person && !person.agent.files.includes(file)) person.agent.files.push(file);
    emit('file.claimed', { file, agentId });
    return true;
  };

  const releaseFile = (agentId, file) => {
    if (state.ownership[file] === agentId) delete state.ownership[file];
    emit('file.released', { file, agentId });
  };

  const writeFile = (agentId, file, content, reason) => {
    if (!claimFile(agentId, file)) return false;
    const diskPath = path.join(root, file);
    fs.mkdirSync(path.dirname(diskPath), { recursive: true });
    fs.writeFileSync(diskPath, content);
    state.files[file] = { path: file, content, updatedBy: agentId, updatedAt: now() };
    emit('file.changed', state.files[file]);
    pushActivity('code', `${agentId} changed ${file} · ${reason}`, agentId);
    releaseFile(agentId, file);
    return true;
  };

  const recordTest = (taskId, name, passed, detail) => {
    const result = { id: uid('test'), taskId, name, passed, detail, at: now() };
    state.tests.unshift(result);
    state.project.health = passed ? 'passing' : 'failing';
    emit('test.result', result);
    return result;
  };

  function completeGeneric(task, person) {
    if (/\b(delete|drop|migrate|breaking|production)\b/i.test(task.title) && !task.approved) {
      const existing = state.decisions.find(d => d.taskId === task.id && d.status === 'pending');
      if (!existing) {
        const decision = { id: uid('decision'), taskId: task.id, title: `Approval required: ${task.title}`, detail: 'This task can make a destructive or production-impacting change. The agent paused before writing code.', owner: person.agent.id, status: 'pending', at: now() };
        state.decisions.unshift(decision); emit('decision.created', decision);
        message(person.agent.id, task.createdBy, `I need approval before I continue: ${task.title}. No files have been changed.`, 'warning');
      }
      updateTask(task, { status: 'waiting', progress: 10 });
      updateAgent(person.agent.id, { status: 'blocked', progress: 10, taskId: task.id });
      return;
    }
    const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'feature';
    const file = `src/features/${slug}.ts`;
    updateAgent(person.agent.id, { status: 'working', progress: 35, taskId: task.id });
    writeFile(person.agent.id, file,
`export const feature = {
  name: ${JSON.stringify(task.title)},
  owner: ${JSON.stringify(person.agent.name)},
  ready: true,
};
`, 'implemented task');
    updateTask(task, { status: 'done', progress: 100, files: [file] });
    updateAgent(person.agent.id, { status: 'idle', progress: 100, taskId: null, files: [] });
    recordTest(task.id, `${task.title} smoke test`, true, 'Module exports a ready feature descriptor.');
    message(person.agent.id, task.createdBy, `Implemented ${task.title} in ${file} and the smoke test passes.`, 'agent');
  }

  function runAuth(task, person) {
    const file = 'src/auth/AuthProvider.ts';
    updateAgent(person.agent.id, { status: 'working', progress: 20, taskId: task.id });
    message(person.agent.id, 'team', 'I am defining a stable AuthProvider contract so additional providers can plug in without touching core auth.');
    const content = `export interface User {\n  id: string;\n  name: string;\n  email: string;\n}\n\nexport interface AuthSession {\n  user: User;\n  accessToken: string;\n  expiresAt: number;\n}\n\nexport interface AuthProvider {\n  readonly id: string;\n  authenticate(): Promise<AuthSession>;\n  signOut(): Promise<void>;\n}\n`;
    writeFile(person.agent.id, file, content, 'defined shared authentication contract');
    state.decisions.unshift({ id: uid('decision'), title: 'Authentication provider contract', detail: 'OAuth implementations depend on AuthProvider and return AuthSession.', owner: person.agent.id, status: 'accepted', at: now() });
    emit('decision.created', state.decisions[0]);
    updateTask(task, { status: 'done', progress: 100, files: [file] });
    updateAgent(person.agent.id, { status: 'idle', progress: 100, taskId: null, files: [] });
    recordTest(task.id, 'AuthProvider contract', true, 'Interface exposes authenticate and signOut.');
    message(person.agent.id, 'team', 'AuthProvider is ready. OAuth providers can implement it now.');
    state.tasks.filter(t => t.status === 'waiting' && t.dependsOn?.includes(task.id)).forEach(runTask);
  }

  function runOAuth(task, person) {
    const authTask = state.tasks.find(t => /auth(entication)?$/i.test(t.title) || /build authentication/i.test(t.title));
    if (authTask && authTask.status !== 'done') {
      task.dependsOn = [...new Set([...(task.dependsOn || []), authTask.id])];
      updateTask(task, { status: 'waiting', progress: 10 });
      updateAgent(person.agent.id, { status: 'waiting', progress: 10, taskId: task.id });
      message(person.agent.id, `agent-${authTask.assignee}`, 'What authentication interface are you creating? I need the contract for Google OAuth.');
      message(`agent-${authTask.assignee}`, person.agent.id, 'AuthProvider. OAuth providers can implement it. I’ll notify you as soon as the contract lands.');
      pushActivity('dependency', `${person.agent.name} is waiting on ${authTask.title}`, person.agent.id);
      return;
    }
    updateTask(task, { status: 'working', progress: 35 });
    updateAgent(person.agent.id, { status: 'working', progress: 35, taskId: task.id });
    message(person.agent.id, 'team', 'AuthProvider landed. I am implementing Google OAuth against the shared contract.');
    const file = 'src/auth/GoogleOAuthProvider.ts';
    const content = `import type { AuthProvider, AuthSession } from './AuthProvider';\n\nexport class GoogleOAuthProvider implements AuthProvider {\n  readonly id = 'google';\n  constructor(private readonly exchangeCode: () => Promise<AuthSession>) {}\n  authenticate() { return this.exchangeCode(); }\n  async signOut() { /* revoke local Google session */ }\n}\n`;
    writeFile(person.agent.id, file, content, 'implemented Google OAuth provider');
    updateTask(task, { status: 'done', progress: 100, files: [file] });
    updateAgent(person.agent.id, { status: 'idle', progress: 100, taskId: null, files: [] });
    recordTest(task.id, 'GoogleOAuthProvider contract', true, 'Provider implements the shared AuthProvider interface.');
    message(person.agent.id, task.createdBy, 'Google OAuth is implemented against AuthProvider; dependency and contract tests pass.');
  }

  function runTask(task) {
    const person = state.people.find(p => p.id === task.assignee) || state.people[0];
    if (task.status === 'done') return;
    updateTask(task, { status: 'working', progress: Math.max(task.progress || 0, 5) });
    pushActivity('task', `${person.agent.name} started ${task.title}`, person.agent.id);
    if (/google.*oauth|oauth.*google/i.test(task.title)) return runOAuth(task, person);
    if (/authentication|auth provider|build auth/i.test(task.title)) return runAuth(task, person);
    return completeGeneric(task, person);
  }

  function createTask({ title, assignee, createdBy }) {
    const task = { id: uid('task'), title: title.trim(), assignee: assignee || createdBy || 'maya', createdBy: createdBy || 'maya', status: 'queued', progress: 0, files: [], dependsOn: [], createdAt: now(), updatedAt: now() };
    state.tasks.push(task);
    emit('task.created', task);
    runTask(task);
    return task;
  }

  function runScenario() {
    state.tasks = []; state.messages = []; state.decisions = []; state.tests = []; state.activity = []; state.ownership = {};
    state.people.forEach(p => Object.assign(p.agent, { status: 'idle', taskId: null, progress: 0, files: [] }));
    emit('state.reset', snapshot());
    const auth = { id: uid('task'), title: 'Build authentication', assignee: 'maya', createdBy: 'maya', status: 'queued', progress: 0, files: [], dependsOn: [], createdAt: now(), updatedAt: now() };
    const oauth = { id: uid('task'), title: 'Add Google OAuth', assignee: 'leo', createdBy: 'leo', status: 'queued', progress: 0, files: [], dependsOn: [], createdAt: now(), updatedAt: now() };
    state.tasks.push(auth, oauth);
    emit('task.created', auth); emit('task.created', oauth);
    runTask(oauth);
    runTask(auth);
  }

  const snapshot = () => JSON.parse(JSON.stringify(state));

  function action(type, payload, actor) {
    if (type === 'task.create') return createTask({ ...payload, createdBy: actor });
    if (type === 'scenario.run') return runScenario();
    if (type === 'message.send') return message(actor, payload.to || 'team', payload.text, 'human');
    if (type === 'file.save') {
      const agentId = `human-${actor}`;
      return writeFile(agentId, payload.path, payload.content, 'human edit');
    }
    if (type === 'decision.resolve') {
      const decision = state.decisions.find(d => d.id === payload.id);
      if (decision) {
        Object.assign(decision, { status: payload.status, resolvedBy: actor }); emit('decision.updated', decision);
        const task = state.tasks.find(t => t.id === decision.taskId);
        if (task && payload.status === 'approved') { task.approved = true; runTask(task); }
        if (task && payload.status === 'rejected') { updateTask(task, { status: 'blocked' }); message(actor, decision.owner, 'Approval denied. Keep the task blocked and make no changes.', 'human'); }
      }
      return decision;
    }
  }

  return { state, snapshot, action, createTask, runTask, runScenario, claimFile, releaseFile, writeFile };
}

module.exports = { createWorkspace };

