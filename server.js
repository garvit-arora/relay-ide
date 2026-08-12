const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { LiveCoordinator } = require('./live-coordinator');

const appRoot = __dirname;
const staticRoot = fs.existsSync(path.join(appRoot, 'dist')) ? path.join(appRoot, 'dist') : path.join(appRoot, 'public');
const dataRoot = path.resolve(process.env.RELAY_DATA_DIR || path.join(appRoot, '.relay-data')); 
const settingsPath = path.join(dataRoot, 'settings.json');
const secretPath = path.join(dataRoot, 'secrets.enc');
const keyPath = path.join(dataRoot, 'master.key');
fs.mkdirSync(dataRoot, { recursive: true });

const defaults = {
  displayName: '', teamServerUrl: '', defaultProvider: 'codex', onboardingComplete: false,
  providers: {
    relay: { enabled: true, executable: '', engine: 'auto', model: '', endpoint: '', deployment: '', customArgs: [] },
    codex: { enabled: true, executable: 'codex', model: '', endpoint: '', deployment: '', customArgs: [] },
    claude: { enabled: false, executable: 'claude', model: '', endpoint: '', deployment: '', customArgs: [] },
    opencode: { enabled: false, executable: 'opencode', model: '', endpoint: '', deployment: '', customArgs: [] },
    azure: { enabled: false, executable: 'codex', model: '', endpoint: '', deployment: '', customArgs: [] },
    custom: { enabled: false, executable: '', model: '', endpoint: '', deployment: '', customArgs: [] }
  }
};
let config = loadJson(settingsPath, defaults);
config = { ...defaults, ...config, providers: { ...defaults.providers, ...(config.providers || {}) } };
const requestedWorkspace = process.env.RELAY_WORKSPACE && fs.existsSync(process.env.RELAY_WORKSPACE) ? fs.realpathSync(process.env.RELAY_WORKSPACE) : null;
let activeWorkspace = requestedWorkspace || (config.lastWorkspace && fs.existsSync(config.lastWorkspace) ? fs.realpathSync(config.lastWorkspace) : null);
const clients = new Set();
const processes = new Map();
const safeJson = value => JSON.stringify(value);
const now = () => Date.now();

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function saveJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function masterKey() {
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Relay secret key is invalid');
  return key;
}
function loadSecrets() {
  try {
    const packed = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(packed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(packed.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(packed.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch { return {}; }
}
function saveSecrets(secrets) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(secrets)), cipher.final()]);
  fs.writeFileSync(secretPath, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }), { mode: 0o600 });
}
function mergeSecrets(next) { const secrets = { ...loadSecrets() }; for (const [key, value] of Object.entries(next || {})) if (String(value).trim()) secrets[key] = String(value); saveSecrets(secrets); }
function send(socket, type, payload) { if (socket.readyState === WebSocket.OPEN) socket.send(safeJson({ type, payload, at: new Date().toISOString() })); }
function broadcast(type, payload) { for (const socket of clients) send(socket, type, payload); }
const collaboration = new LiveCoordinator({ root: activeWorkspace || appRoot, dataDir: dataRoot, emit: broadcast });
function reply(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(safeJson(value)); }
function parseBody(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', c => { body += c; if (body.length > 10_000_000) reject(new Error('Request too large')); }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } }); req.on('error', reject); }); }
function canonicalWorkspace(requested) {
  const raw = requested || activeWorkspace;
  if (!raw) throw new Error('No workspace is open');
  const resolved = fs.realpathSync(path.resolve(raw));
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Workspace must be a directory');
  return resolved;
}
function safePath(root, relative, allowNew = false) {
  if (!relative || path.isAbsolute(relative)) throw new Error('A workspace-relative path is required');
  const candidate = path.resolve(root, relative);
  const checked = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
  if (checked !== root && !checked.startsWith(root + path.sep)) throw new Error('Path escapes the open workspace');
  if (!fs.existsSync(candidate) && !allowNew) throw new Error('File does not exist');
  return candidate;
}
function commandInfo(id, name = id) {
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [id], { encoding: 'utf8', windowsHide: true });
  const found = lookup.status === 0 ? String(lookup.stdout).split(/\r?\n/).find(Boolean)?.trim() || '' : '';
  if (!found) return { id, name, installed: false, version: '', path: '' };
  if (id === 'az') return { id, name, installed: true, path: found, version: 'Azure CLI installed' };
  const versionRun = spawnSync(found, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
  return { id, name, installed: true, path: found, version: String(versionRun.stdout || versionRun.stderr || '').trim().split(/\r?\n/)[0] || 'Installed' };
}
function listWorkspace(root) {
  const ignored = new Set(['node_modules', '.git', 'target', 'dist', '.next', '.relay-data']); const result = [];
  function walk(dir, depth) {
    if (depth > 8 || result.length >= 2500) return;
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      if (ignored.has(entry.name) || result.length >= 2500) continue;
      const full = path.join(dir, entry.name); const rel = path.relative(root, full).replaceAll('\\', '/');
      result.push({ path: rel, name: entry.name, isDir: entry.isDirectory(), depth });
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  }
  walk(root, 0); return result;
}
function discoverSkills() {
  const roots = [];
  const home = os.homedir();
  roots.push(['Codex', path.join(home, '.codex', 'skills')], ['Claude', path.join(home, '.claude', 'skills')], ['Agents', path.join(home, '.agents', 'skills')]);
  if (activeWorkspace) roots.push(['Workspace', path.join(activeWorkspace, '.codex', 'skills')], ['Workspace', path.join(activeWorkspace, '.claude', 'skills')], ['Workspace', path.join(activeWorkspace, '.agents', 'skills')]);
  const result = [];
  function walk(source, dir, depth = 0) {
    if (depth > 4 || result.length >= 200 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(source, full, depth + 1);
      else if (entry.name === 'SKILL.md') {
        const text = fs.readFileSync(full, 'utf8');
        const name = text.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1] || path.basename(path.dirname(full));
        const description = text.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] || 'Reusable agent workflow';
        result.push({ id: crypto.randomUUID(), name, description, source, path: full });
      }
    }
  }
  for (const [source, dir] of roots) walk(source, dir); return result;
}
function emitProcess(id, kind, text) { broadcast('agent-event', { agentId: id, kind, text: String(text), at: now() }); }
function consumeCoordinationLine(agentId, line) {
  const marker = 'RELAY_EVENT:';
  const index = line.indexOf(marker);
  if (index < 0) return;
  try {
    const event = JSON.parse(line.slice(index + marker.length).trim());
    collaboration.action(event.type, event.payload || {}, agentId);
  } catch (error) { emitProcess(agentId, 'stderr', `Invalid RELAY_EVENT: ${error.message}`); }
}
function spawnProcess({ id, executable, args = [], cwd, env = {}, shell = false, taskId = null, stdin = 'ignore' }) {
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...env, RELAY_AGENT_ID: id, RELAY_TASK_ID: taskId || '', RELAY_BACKEND_URL: 'http://127.0.0.1:4173' }, shell, windowsHide: true, stdio: [stdin, 'pipe', 'pipe'] });
  processes.set(id, child); emitProcess(id, 'started', `Started ${executable}`); if (collaboration.state.agents[id]) collaboration.setAgentStatus(id, 'working', `Running ${executable}`, 5);
  const pipe = (stream, kind) => { let pending = ''; stream.setEncoding('utf8'); stream.on('data', chunk => { pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop(); for (const line of lines) if (line) { consumeCoordinationLine(id, line); emitProcess(id, kind, line); } }); stream.on('end', () => { if (pending) { consumeCoordinationLine(id, pending); emitProcess(id, kind, pending); } }); };
  pipe(child.stdout, 'stdout'); pipe(child.stderr, 'stderr');
  child.on('error', error => { emitProcess(id, 'stderr', error.message); if (collaboration.state.agents[id]) collaboration.setAgentStatus(id, 'failed', error.message); });
  child.on('close', code => { processes.delete(id); const success = code === 0; emitProcess(id, 'exit', `Process finished with ${code ?? -1}`); if (taskId) collaboration.completeTask(taskId, { actor: id, success, summary: success ? 'Agent process completed successfully.' : `Agent process exited with ${code ?? -1}.` }); else if (collaboration.state.agents[id]) collaboration.setAgentStatus(id, success ? 'done' : 'failed', `Exit ${code ?? -1}`, 100); });
}
function shellCommand(command) { return process.platform === 'win32' ? { executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', command] } : { executable: 'sh', args: ['-lc', command] }; }
function agentContext(agentId, task, prompt) {
  const relayCli = JSON.stringify(path.join(appRoot, 'scripts', 'relay-agent.js'));
  const state = collaboration.snapshot();
  const teammates = Object.values(state.agents).filter(agent => agent.id !== agentId).map(agent => ({ id: agent.id, status: agent.status, taskId: agent.taskId, files: agent.files }));
  const identity = task.metadata?.provider === 'relay' ? "You are Relay Code, Relay IDE's native coding agent. You are not GitHub Copilot. Use the configured open coding engine while preserving Relay coordination, file ownership, decisions, and rooms." : `You are ${agentId}, a first-class teammate in Relay.`;
  return `${prompt}\n\n${identity} Your task id is ${task.id}.\nActive teammates: ${JSON.stringify(teammates)}\nOpen tasks: ${JSON.stringify(Object.values(state.tasks).filter(item => item.status !== 'done').map(item => ({ id: item.id, title: item.title, assignee: item.assignee, status: item.status, dependsOn: item.dependsOn })))}\nBefore editing a shared file, claim it with: node ${relayCli} file.claim --file <path>\nMessage another agent with: node ${relayCli} message.send --to <agent-id> --text <message>\nDeclare a dependency with: node ${relayCli} task.dependency --taskId ${task.id} --dependencyId <task-id>\nAsk a human with: node ${relayCli} decision.request --taskId ${task.id} --title <question> --detail <context>\nRecord durable decisions with: node ${relayCli} memory.create --title <title> --content <content>\nRelease files when done. Do not invent teammate responses; use the Relay commands and wait for real state changes.`;
}
function repairStaleCodexCache() {
  const cache = path.join(os.homedir(), '.codex', 'models_cache.json');
  try {
    const text = fs.readFileSync(cache, 'utf8');
    if (!text.includes('supports_reasoning_summaries')) {
      const backup = `${cache}.relay-stale-${Date.now()}`;
      fs.renameSync(cache, backup);
      broadcast('runtime.notice', { provider: 'codex', level: 'info', text: 'Relay removed an incompatible Codex model cache. Codex will refresh it automatically.', backup });
    }
  } catch {}
}
function startAgent(request) {
  const root = canonicalWorkspace(request.workspace); const id = `agent-${crypto.randomUUID()}`; let provider = request.provider;
  const requestedProvider = provider;
  if (provider === 'relay') {
    const preferred = config.providers.relay?.engine;
    provider = preferred && preferred !== 'auto' ? preferred : (commandInfo('opencode', 'OpenCode').installed ? 'opencode' : commandInfo('codex', 'Codex').installed ? 'codex' : commandInfo('claude', 'Claude').installed ? 'claude' : 'custom');
  }
  const task = request.taskId && collaboration.state.tasks[request.taskId] ? collaboration.state.tasks[request.taskId] : collaboration.createTask({ title: request.prompt.slice(0, 120), description: request.prompt, createdBy: config.displayName || 'human', assignee: id, metadata: { provider: requestedProvider, engine: provider } });
  collaboration.registerAgent({ id, name: request.name || (requestedProvider === 'relay' ? 'Relay Code' : `${provider} agent`), provider: requestedProvider, engine: provider, ownerId: config.displayName || 'human', taskId: task.id });
  if (task.assignee !== id) collaboration.assignTask(task.id, id);
  const prompt = agentContext(id, task, request.prompt);
  const common = { id, cwd: root, taskId: task.id };
  if (provider === 'codex') { repairStaleCodexCache(); spawnProcess({ ...common, stdin: 'inherit', executable: config.providers.codex.executable || 'codex', args: ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', root, ...(request.model ? ['-m', request.model] : []), prompt] }); }
  else if (provider === 'claude') spawnProcess({ ...common, executable: config.providers.claude.executable || 'claude', args: ['-p', prompt, '--output-format', 'stream-json', '--verbose'] });
  else if (provider === 'opencode') spawnProcess({ ...common, executable: config.providers.opencode.executable || 'opencode', args: ['run', ...(request.model ? ['--model', request.model] : []), prompt] });
  else if (provider === 'custom') {
    const template = request.customCommand || config.providers.custom.executable; if (!template) throw new Error('Configure a custom agent command first');
    const command = template.replaceAll('{prompt}', JSON.stringify(prompt)).replaceAll('{workspace}', JSON.stringify(root)); const shell = shellCommand(command); spawnProcess({ ...common, ...shell });
  } else if (provider === 'azure') {
    const azure = config.providers.azure; const key = loadSecrets().azure; if (!key) throw new Error('Azure API key is not configured'); if (!azure.endpoint || !azure.deployment) throw new Error('Azure endpoint and deployment are required');
    const endpoint = azure.endpoint.replace(/\/$/, '') + '/openai/v1';
    repairStaleCodexCache(); spawnProcess({ ...common, stdin: 'inherit', executable: azure.executable || 'codex', env: { AZURE_OPENAI_API_KEY: key }, args: ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', root, '-c', 'model_provider="azure"', '-c', 'model_providers.azure.name="Azure OpenAI"', '-c', `model_providers.azure.base_url="${endpoint}"`, '-c', 'model_providers.azure.env_key="AZURE_OPENAI_API_KEY"', '-c', 'model_providers.azure.wire_api="responses"', '-m', request.model || azure.deployment, prompt] });
  } else throw new Error('Unsupported provider');
  return { id, taskId: task.id };
}

async function invoke(command, args) {
  switch (command) {
    case 'detect_tools': return [commandInfo('codex','OpenAI Codex'), commandInfo('claude','Claude Code'), commandInfo('opencode','OpenCode'), commandInfo('az','Azure CLI'), commandInfo('git','Git'), commandInfo('node','Node.js')];
    case 'get_config': return config;
    case 'save_config': config = { ...defaults, ...config, ...args.config, lastWorkspace: args.config?.lastWorkspace || config.lastWorkspace || activeWorkspace || '', providers: { ...defaults.providers, ...(args.config?.providers || {}) } }; saveJson(settingsPath, config); mergeSecrets(args.secrets); return true;
    case 'has_secret': return Boolean(loadSecrets()[args.provider]);
    case 'open_workspace': activeWorkspace = canonicalWorkspace(args.path); config.lastWorkspace = activeWorkspace; saveJson(settingsPath, config); broadcast('workspace.changed', { path: activeWorkspace }); return activeWorkspace;
    case 'list_workspace': return listWorkspace(canonicalWorkspace(args.workspace));
    case 'read_workspace_file': { const root = canonicalWorkspace(); const file = safePath(root, args.path); const stat = fs.statSync(file); if (stat.size > 5_000_000) throw new Error('File is larger than 5 MB'); const value = fs.readFileSync(file); if (value.includes(0)) throw new Error('Binary files cannot be opened'); return value.toString('utf8'); }
    case 'write_workspace_file': { const root = canonicalWorkspace(); const file = safePath(root, args.path, true); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, args.content); broadcast('file.changed', { path: args.path, updatedBy: config.displayName || 'user', updatedAt: new Date().toISOString() }); return true; }
    case 'create_entry': { const root = canonicalWorkspace(); const target = safePath(root, args.path, true); if (args.isDir) fs.mkdirSync(target, { recursive: true }); else { fs.mkdirSync(path.dirname(target), { recursive: true }); if (!fs.existsSync(target)) fs.writeFileSync(target, ''); } broadcast('workspace.refresh', {}); return true; }
    case 'run_command': { const root = canonicalWorkspace(); const id = `terminal-${crypto.randomUUID()}`; const shell = shellCommand(args.command); spawnProcess({ id, ...shell, cwd: root }); return id; }
    case 'stop_process': { const child = processes.get(args.id); if (!child) return false; child.kill(); return true; }
    case 'start_agent': return startAgent(args.request);
    case 'coordination_snapshot': return collaboration.snapshot();
    case 'coordination_action': return collaboration.action(args.type, args.payload || {}, args.actor || config.displayName || 'human');
    case 'list_skills': return discoverSkills();
    case 'git_status': { const root = canonicalWorkspace(); const out = spawnSync('git', ['status', '--short', '--branch'], { cwd: root, encoding: 'utf8', windowsHide: true }); if (out.error) throw out.error; return String(out.stdout || out.stderr); }
    case 'search_workspace': { const root = canonicalWorkspace(); const query = String(args.query || '').toLowerCase(); return listWorkspace(root).filter(x => !x.isDir && x.path.toLowerCase().includes(query)).slice(0, 200); }
    default: throw new Error(`Unknown backend command: ${command}`);
  }
}

const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.ttf':'font/ttf','.png':'image/png' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return reply(res, 200, { ok:true, clients:clients.size, workspace:activeWorkspace, processes:processes.size });
  if (url.pathname === '/api/invoke' && req.method === 'POST') { try { const body = await parseBody(req); return reply(res, 200, { ok:true, result:await invoke(body.command, body.args || {}) }); } catch (error) { return reply(res, 400, { ok:false, error:error.message }); } }
  let requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); let file = path.normalize(path.join(staticRoot, requested));
  if (!file.startsWith(staticRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(staticRoot, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Run npm run build first'); }
  res.writeHead(200, { 'content-type':mime[path.extname(file)] || 'application/octet-stream', 'cache-control':path.basename(file)==='index.html'?'no-store':'public, max-age=31536000, immutable' }); fs.createReadStream(file).pipe(res);
});
const wss = new WebSocket.Server({ server });
wss.on('connection', socket => {
  clients.add(socket); send(socket, 'backend.ready', { workspace:activeWorkspace, config:{ displayName:config.displayName } }); send(socket, 'state.snapshot', collaboration.snapshot());
  socket.on('message', raw => { try { const event=JSON.parse(raw); collaboration.action(event.type, event.payload || {}, config.displayName || 'human'); } catch(error) { send(socket,'error',{message:error.message}); } });
  socket.on('close',()=>clients.delete(socket));
});
const port=Number(process.env.PORT||4173); server.listen(port,'127.0.0.1',()=>console.log(`Relay coordination backend: http://127.0.0.1:${port}`));
