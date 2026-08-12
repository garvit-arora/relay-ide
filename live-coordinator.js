const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));

class LiveCoordinator {
  constructor({ root, dataDir, emit = () => {} }) {
    this.root = path.resolve(root);
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'coordination.json');
    this.emit = emit;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.state = this.load();
  }

  emptyState() {
    return {
      version: 1,
      project: { id: 'relay', name: path.basename(this.root), root: this.root, health: 'unknown', updatedAt: now() },
      humans: {}, agents: {}, tasks: {}, messages: [], ownership: {}, decisions: {}, memory: [], tests: [], activity: [],
    };
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...this.emptyState(), ...saved, project: { ...this.emptyState().project, ...(saved.project || {}), root: this.root } };
    } catch { return this.emptyState(); }
  }

  persist() {
    this.state.project.updatedAt = now();
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    fs.renameSync(temp, this.file);
  }

  publish(type, payload) {
    this.persist();
    this.emit(type, clone(payload));
    return payload;
  }

  activity(type, text, actor = 'system', data = {}) {
    const item = { id: id('activity'), type, text, actor, data, at: now() };
    this.state.activity.unshift(item);
    this.state.activity = this.state.activity.slice(0, 200);
    return this.publish('activity', item);
  }

  registerHuman({ id: humanId, name, sessionId }) {
    const key = humanId || `human-${crypto.createHash('sha1').update(name || sessionId || 'user').digest('hex').slice(0, 10)}`;
    const human = this.state.humans[key] || { id: key, name: name || 'Developer', joinedAt: now() };
    Object.assign(human, { name: name || human.name, sessionId, online: true, lastSeenAt: now() });
    this.state.humans[key] = human;
    return this.publish('human.updated', human);
  }

  registerAgent({ id: agentId, name, provider, ownerId, taskId }) {
    const key = agentId || id('agent');
    const agent = this.state.agents[key] || { id: key, createdAt: now(), files: [] };
    Object.assign(agent, { name: name || provider || 'Agent', provider, ownerId, taskId: taskId || agent.taskId || null, status: 'starting', progress: 0, lastSeenAt: now() });
    this.state.agents[key] = agent;
    return this.publish('agent.updated', agent);
  }

  createTask({ title, description = '', createdBy = 'human', assignee = null, metadata = {} }) {
    if (!title?.trim()) throw new Error('Task title is required');
    const task = { id: id('task'), title: title.trim(), description, createdBy, assignee, status: assignee ? 'assigned' : 'queued', progress: 0, dependsOn: [], blockedBy: [], files: [], metadata, createdAt: now(), updatedAt: now() };
    this.state.tasks[task.id] = task;
    this.publish('task.created', task);
    this.activity('task', `${createdBy} created ${task.title}`, createdBy, { taskId: task.id });
    return task;
  }

  assignTask(taskId, agentId) {
    const task = this.requireTask(taskId); this.requireAgent(agentId);
    task.assignee = agentId; task.status = this.unfinishedDependencies(task).length ? 'waiting' : 'assigned'; task.updatedAt = now();
    this.state.agents[agentId].taskId = taskId;
    this.publish('task.updated', task); this.publish('agent.updated', this.state.agents[agentId]);
    return task;
  }

  addDependency(taskId, dependencyId, actor = 'system') {
    const task = this.requireTask(taskId); this.requireTask(dependencyId);
    if (taskId === dependencyId) throw new Error('A task cannot depend on itself');
    if (this.pathExists(dependencyId, taskId)) throw new Error('Dependency would create a cycle');
    if (!task.dependsOn.includes(dependencyId)) task.dependsOn.push(dependencyId);
    task.blockedBy = this.unfinishedDependencies(task); task.status = task.blockedBy.length ? 'waiting' : task.status; task.updatedAt = now();
    this.publish('dependency.created', { taskId, dependencyId, actor });
    this.publish('task.updated', task);
    const dependency = this.state.tasks[dependencyId];
    this.message({ from: actor, to: dependency.assignee || dependency.createdBy, text: `${task.title} is waiting on ${dependency.title}. Please notify the dependent agent when the contract is ready.`, kind: 'dependency', taskId });
    return task;
  }

  setAgentStatus(agentId, status, detail = '', progress) {
    const agent = this.requireAgent(agentId);
    Object.assign(agent, { status, detail, lastSeenAt: now(), ...(Number.isFinite(progress) ? { progress } : {}) });
    if (agent.taskId && this.state.tasks[agent.taskId]) {
      const task = this.state.tasks[agent.taskId];
      if (['working', 'waiting', 'blocked'].includes(status)) task.status = status;
      if (Number.isFinite(progress)) task.progress = progress;
      task.updatedAt = now(); this.publish('task.updated', task);
    }
    return this.publish('agent.updated', agent);
  }

  completeTask(taskId, { actor = 'system', summary = '', files = [], success = true } = {}) {
    const task = this.requireTask(taskId);
    Object.assign(task, { status: success ? 'done' : 'failed', progress: 100, summary, files: [...new Set([...(task.files || []), ...files])], completedAt: now(), updatedAt: now() });
    this.publish('task.updated', task);
    if (task.assignee && this.state.agents[task.assignee]) this.setAgentStatus(task.assignee, success ? 'done' : 'failed', summary, 100);
    this.releaseAll(task.assignee);
    for (const candidate of Object.values(this.state.tasks)) {
      if (!candidate.dependsOn.includes(taskId)) continue;
      candidate.blockedBy = this.unfinishedDependencies(candidate);
      if (!candidate.blockedBy.length && candidate.status === 'waiting') {
        candidate.status = 'assigned'; candidate.updatedAt = now(); this.publish('task.updated', candidate);
        if (candidate.assignee) {
          this.message({ from: 'team-lead', to: candidate.assignee, text: `${task.title} is complete. ${candidate.title} is unblocked and ready to continue.`, kind: 'unblocked', taskId: candidate.id });
          this.setAgentStatus(candidate.assignee, 'ready', 'Dependency completed', candidate.progress);
        }
      }
    }
    this.activity('task', `${actor} ${success ? 'completed' : 'failed'} ${task.title}`, actor, { taskId });
    this.teamLeadReview();
    return task;
  }

  message({ from, to = 'team', text, kind = 'agent', taskId = null, replyTo = null }) {
    if (!text?.trim()) throw new Error('Message text is required');
    const item = { id: id('message'), from, to, text: text.trim(), kind, taskId, replyTo, at: now(), delivered: true };
    this.state.messages.push(item); this.state.messages = this.state.messages.slice(-500);
    return this.publish('message', item);
  }

  claimFile(agentId, file) {
    this.requireAgent(agentId);
    const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
    const owner = this.state.ownership[normalized];
    if (owner && owner !== agentId) {
      const conflict = { file: normalized, owner, requestedBy: agentId, at: now() };
      this.publish('file.conflict', conflict);
      this.message({ from: 'team-lead', to: agentId, text: `${normalized} is currently owned by ${owner}. Coordinate or request a handoff before editing.`, kind: 'conflict' });
      this.setAgentStatus(agentId, 'blocked', `File conflict: ${normalized}`);
      return { ok: false, ...conflict };
    }
    this.state.ownership[normalized] = agentId;
    const agent = this.state.agents[agentId]; if (!agent.files.includes(normalized)) agent.files.push(normalized);
    this.publish('file.claimed', { file: normalized, agentId, at: now() });
    return { ok: true, file: normalized, agentId };
  }

  releaseFile(agentId, file) {
    const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
    if (this.state.ownership[normalized] === agentId) delete this.state.ownership[normalized];
    const agent = this.state.agents[agentId]; if (agent) agent.files = agent.files.filter(item => item !== normalized);
    return this.publish('file.released', { file: normalized, agentId, at: now() });
  }

  releaseAll(agentId) {
    if (!agentId) return;
    for (const [file, owner] of Object.entries(this.state.ownership)) if (owner === agentId) delete this.state.ownership[file];
    if (this.state.agents[agentId]) this.state.agents[agentId].files = [];
    this.publish('files.released', { agentId, at: now() });
  }

  requestDecision({ taskId, agentId, title, detail, options = [] }) {
    if (taskId) this.requireTask(taskId); if (agentId) this.requireAgent(agentId);
    const decision = { id: id('decision'), taskId, agentId, title, detail, options, status: 'pending', createdAt: now() };
    this.state.decisions[decision.id] = decision;
    this.publish('decision.created', decision);
    if (agentId) this.setAgentStatus(agentId, 'blocked', title);
    return decision;
  }

  resolveDecision(decisionId, status, actor, response = '') {
    const decision = this.state.decisions[decisionId]; if (!decision) throw new Error(`Unknown decision ${decisionId}`);
    Object.assign(decision, { status, response, resolvedBy: actor, resolvedAt: now() }); this.publish('decision.updated', decision);
    if (decision.agentId) {
      this.message({ from: actor, to: decision.agentId, text: `Decision resolved: ${decision.title} → ${status}${response ? ` — ${response}` : ''}`, kind: 'decision', taskId: decision.taskId });
      this.setAgentStatus(decision.agentId, status === 'approved' ? 'ready' : 'blocked', response || status);
    }
    return decision;
  }

  remember({ actor, title, content, tags = [] }) {
    const item = { id: id('memory'), actor, title, content, tags, at: now() };
    this.state.memory.unshift(item); this.state.memory = this.state.memory.slice(0, 200);
    return this.publish('memory.created', item);
  }

  recordTest({ taskId, agentId, name, passed, detail = '' }) {
    const result = { id: id('test'), taskId, agentId, name, passed: Boolean(passed), detail, at: now() };
    this.state.tests.unshift(result); this.state.tests = this.state.tests.slice(0, 300);
    this.state.project.health = passed ? 'passing' : 'failing';
    return this.publish('test.result', result);
  }

  teamLeadReview() {
    const conflicts = Object.entries(this.state.ownership).filter(([, owner]) => !this.state.agents[owner]);
    const blocked = Object.values(this.state.tasks).filter(task => task.status === 'waiting' && !task.blockedBy.length);
    const report = { conflicts, blocked: blocked.map(task => task.id), at: now() };
    if (blocked.length) for (const task of blocked) this.message({ from: 'team-lead', to: task.assignee || task.createdBy, text: `${task.title} is marked waiting but has no unfinished dependency. Please continue or explain the blocker.`, kind: 'lead', taskId: task.id });
    return this.publish('teamlead.review', report);
  }

  action(type, payload = {}, actor = 'system') {
    switch (type) {
      case 'human.register': return this.registerHuman({ ...payload, name: payload.name || actor });
      case 'agent.register': return this.registerAgent(payload);
      case 'agent.status': return this.setAgentStatus(payload.agentId || actor, payload.status, payload.detail, payload.progress);
      case 'task.create': return this.createTask({ ...payload, createdBy: payload.createdBy || actor });
      case 'task.assign': return this.assignTask(payload.taskId, payload.agentId);
      case 'task.dependency': return this.addDependency(payload.taskId, payload.dependencyId, actor);
      case 'task.complete': return this.completeTask(payload.taskId, { ...payload, actor });
      case 'message.send': return this.message({ ...payload, from: payload.from || actor });
      case 'file.claim': return this.claimFile(payload.agentId || actor, payload.file);
      case 'file.release': return this.releaseFile(payload.agentId || actor, payload.file);
      case 'decision.request': return this.requestDecision({ ...payload, agentId: payload.agentId || actor });
      case 'decision.resolve': return this.resolveDecision(payload.decisionId || payload.id, payload.status, actor, payload.response);
      case 'memory.create': return this.remember({ ...payload, actor });
      case 'test.record': return this.recordTest({ ...payload, agentId: payload.agentId || actor });
      case 'teamlead.review': return this.teamLeadReview();
      default: throw new Error(`Unknown coordination action: ${type}`);
    }
  }

  requireTask(taskId) { const task = this.state.tasks[taskId]; if (!task) throw new Error(`Unknown task ${taskId}`); return task; }
  requireAgent(agentId) { const agent = this.state.agents[agentId]; if (!agent) throw new Error(`Unknown agent ${agentId}`); return agent; }
  unfinishedDependencies(task) { return task.dependsOn.filter(taskId => this.state.tasks[taskId]?.status !== 'done'); }
  pathExists(fromId, targetId, seen = new Set()) { if (fromId === targetId) return true; if (seen.has(fromId)) return false; seen.add(fromId); return (this.state.tasks[fromId]?.dependsOn || []).some(next => this.pathExists(next, targetId, seen)); }
  snapshot() { return clone(this.state); }
}

module.exports = { LiveCoordinator };
