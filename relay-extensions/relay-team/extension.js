const vscode = require('vscode');

const BACKEND = 'http://127.0.0.1:4173';

async function api(command, args = {}) {
  const response = await fetch(`${BACKEND}/api/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Relay backend request failed');
  return data.result;
}

function nonce() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

class TeamViewProvider {
  constructor(context) { this.context = context; this.view = undefined; }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = teamHtml(view.webview);
    view.webview.onDidReceiveMessage(async message => {
      try {
        if (message.type === 'ready') {
          const [config, tools, skills] = await Promise.all([api('get_config'), api('detect_tools'), api('list_skills').catch(() => [])]);
          view.webview.postMessage({ type: 'bootstrap', config, tools, skills, workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '' });
        }
        if (message.type === 'runAgent') {
          const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!workspace) throw new Error('Open a workspace folder first.');
          const id = await api('start_agent', { request: { provider: message.provider, prompt: message.prompt, workspace, model: null, customCommand: message.customCommand || null } });
          view.webview.postMessage({ type: 'agentStarted', id, provider: message.provider, prompt: message.prompt });
        }
        if (message.type === 'terminal') {
          const terminal = vscode.window.createTerminal({ name: 'Relay Task', cwd: vscode.workspace.workspaceFolders?.[0]?.uri });
          terminal.show(); terminal.sendText(message.command, true);
        }
        if (message.type === 'onboarding') openOnboarding(this.context);
        if (message.type === 'warRoom') openWarRoom(this.context);
        if (message.type === 'openFile') {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          if (root) vscode.window.showTextDocument(vscode.Uri.joinPath(root, message.path));
        }
      } catch (error) { view.webview.postMessage({ type: 'error', message: String(error.message || error) }); }
    });
  }
}

function shell(body, script, title = 'Relay') {
  const n = nonce();
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles()}</style></head><body>${body}<script nonce="${n}">${script}</script></body></html>`;
}

function teamHtml() {
  return shell(`<header><div><small>AI TEAM</small><h2>Workspace agents</h2></div><button id="setup" title="Configure Relay">?</button></header>
  <nav><button class="active" data-tab="agents">Agents <i id="count">0</i></button><button data-tab="chat">Team chat</button><button data-tab="skills">Skills</button></nav>
  <main id="content"><div class="empty"><div class="orb">R</div><h3>Your team is ready</h3><p>Run Codex, Claude Code, Azure, or a custom CLI inside this VS Code workspace.</p></div></main>
  <section class="composer"><div class="meta"><select id="provider"></select><span>workspace write</span></div><textarea id="prompt" placeholder="Ask an agent to build, fix, or explain…"></textarea><footer><button id="tests">Run tests</button><button id="send">Run agent ?</button></footer></section>`, `
  const vscode=acquireVsCodeApi(),content=document.getElementById('content'),runs=new Map();let current='agents',skills=[],socket;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function connect(){socket=new WebSocket('ws://127.0.0.1:4173');socket.onmessage=e=>{const x=JSON.parse(e.data);if(x.type==='agent-event'){const ev=x.payload;let run=runs.get(ev.agentId)||{id:ev.agentId,name:'Workspace agent',prompt:'Running…',status:'working',events:[]};run.events.push(ev);if(ev.kind==='exit')run.status=ev.text.endsWith('0')?'done':'failed';runs.set(ev.agentId,run);render()}if(x.type==='message'){window.messages=window.messages||[];window.messages.push(x.payload);render()}};socket.onclose=()=>setTimeout(connect,1000)}
  function render(){document.getElementById('count').textContent=[...runs.values()].filter(x=>x.status==='working').length;if(current==='agents'){const list=[...runs.values()];content.innerHTML=list.length?list.map(r=>'<article><div class="agentTop"><div class="orb small">'+esc((r.provider||'R')[0].toUpperCase())+'</div><div><b>'+esc(r.name)+'</b><em class="'+r.status+'">'+r.status+'</em></div></div><p>'+esc(r.prompt)+'</p><div class="stream">'+r.events.slice(-10).map(e=>'<div class="'+e.kind+'"><i>›</i><span>'+esc(format(e.text))+'</span></div>').join('')+'</div></article>').join(''):'<div class="empty"><div class="orb">R</div><h3>No agents running</h3><p>Describe a task below to launch a real agent process.</p></div>'}else if(current==='skills'){content.innerHTML=skills.length?skills.map(s=>'<div class="skill"><b>'+esc(s.name)+'</b><em>'+esc(s.source)+'</em><p>'+esc(s.description)+'</p></div>').join(''):'<div class="empty"><p>No skills discovered.</p></div>'}else{const msgs=window.messages||[];content.innerHTML=msgs.length?msgs.map(m=>'<div class="msg"><b>'+esc(m.from)+'</b><p>'+esc(m.text)+'</p></div>').join(''):'<div class="empty"><p>Team and agent messages appear here live.</p></div>'}}
  function format(line){try{const x=JSON.parse(line);return x.item?.text||x.message?.content||x.type||line}catch{return line}}
  document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');current=b.dataset.tab;render()});
  document.getElementById('send').onclick=()=>{const prompt=document.getElementById('prompt').value.trim(),provider=document.getElementById('provider').value;if(!prompt)return;vscode.postMessage({type:'runAgent',prompt,provider});document.getElementById('prompt').value=''};
  document.getElementById('tests').onclick=()=>vscode.postMessage({type:'terminal',command:'npm test'});document.getElementById('setup').onclick=()=>vscode.postMessage({type:'onboarding'});
  window.addEventListener('message',e=>{const x=e.data;if(x.type==='bootstrap'){skills=x.skills;const enabled=Object.entries(x.config.providers||{}).filter(([,p])=>p.enabled);document.getElementById('provider').innerHTML=enabled.map(([id])=>'<option value="'+id+'">'+({codex:'Codex',claude:'Claude Code',opencode:'OpenCode',azure:'Azure OpenAI',custom:'Custom CLI'}[id]||id)+'</option>').join('');render()}if(x.type==='agentStarted'){runs.set(x.id,{id:x.id,provider:x.provider,name:({codex:'Codex',claude:'Claude Code',opencode:'OpenCode',azure:'Azure OpenAI',custom:'Custom CLI'}[x.provider]||x.provider),prompt:x.prompt,status:'working',events:[]});render()}if(x.type==='error')alert(x.message)});connect();vscode.postMessage({type:'ready'});`);
}

async function openOnboarding(context) {
  const panel = vscode.window.createWebviewPanel('relay.onboarding', 'Relay Setup', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  const [config, tools] = await Promise.all([api('get_config'), api('detect_tools')]);
  panel.webview.html = onboardingHtml(config, tools);
  panel.webview.onDidReceiveMessage(async m => {
    if (m.type === 'save') { await api('save_config', { config: { ...m.config, onboardingComplete: true }, secrets: m.secrets }); vscode.window.showInformationMessage('Relay setup saved.'); panel.dispose(); }
  });
}

function onboardingHtml(config, tools) {
  return shell(`<div class="setup"><aside><div class="brand"><span>R</span><b>Relay</b></div><p>SETUP</p><ol><li class="active">Profile</li><li>Agent runtimes</li><li>Azure OpenAI</li><li>Finish</li></ol></aside><main class="form"><small>WELCOME TO RELAY</small><h1>Bring your whole<br>engineering team into the IDE.</h1><p class="lead">Configure the humans, agents, and model providers that work together in this workspace.</p><div class="grid"><label>Your name<input id="name" value="${String(config.displayName||'').replaceAll('"','&quot;')}" placeholder="Maya Chen"></label><label>Team relay URL<input id="relay" value="${String(config.teamServerUrl||'ws://127.0.0.1:4173').replaceAll('"','&quot;')}"></label></div><h3>Agent runtimes</h3><div id="tools" class="tools"></div><h3>Azure OpenAI <span>optional</span></h3><div class="grid"><label>Endpoint<input id="endpoint" value="${String(config.providers?.azure?.endpoint||'').replaceAll('"','&quot;')}" placeholder="https://resource.openai.azure.com"></label><label>Deployment<input id="deployment" value="${String(config.providers?.azure?.deployment||'').replaceAll('"','&quot;')}" placeholder="gpt-5.4"></label></div><label>API key<input id="key" type="password" placeholder="Encrypted by the Relay backend"></label><footer><span>Secrets never enter workspace files.</span><button id="save">Save and enter Relay ?</button></footer></main></div>`, `const vscode=acquireVsCodeApi(),config=${JSON.stringify(config)},tools=${JSON.stringify(tools)};document.getElementById('tools').innerHTML=tools.filter(t=>['codex','claude','opencode'].includes(t.id)).map(t=>'<label class="tool"><span class="orb small">'+t.name[0]+'</span><span><b>'+t.name+'</b><em>'+ (t.installed?t.version:'Not installed')+'</em></span><input type="checkbox" data-id="'+t.id+'" '+((config.providers?.[t.id]?.enabled&&t.installed)?'checked':'')+' '+(!t.installed?'disabled':'')+'></label>').join('');document.getElementById('save').onclick=()=>{document.querySelectorAll('[data-id]').forEach(x=>config.providers[x.dataset.id].enabled=x.checked);config.displayName=document.getElementById('name').value;config.teamServerUrl=document.getElementById('relay').value;config.providers.azure.endpoint=document.getElementById('endpoint').value;config.providers.azure.deployment=document.getElementById('deployment').value;config.providers.azure.enabled=!!config.providers.azure.endpoint;vscode.postMessage({type:'save',config,secrets:{azure:document.getElementById('key').value}})}}`, 'Relay Setup');
}

function openWarRoom(context) {
  const panel = vscode.window.createWebviewPanel('relay.warRoom', 'Relay War Room', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = shell(`<div class="war"><small>PROJECT OPERATIONS</small><h1>War Room</h1><p>Users ? agents ? tasks ? dependencies ? files ? tests</p><div id="events" class="wargrid"><section><h3>Live execution</h3><div class="empty"><p>Waiting for agent activity…</p></div></section><section><h3>Team communication</h3><div class="empty"><p>Waiting for messages…</p></div></section></div></div>`, `const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));const ws=new WebSocket('ws://127.0.0.1:4173'),events=document.getElementById('events');let activity=[],messages=[];ws.onmessage=e=>{const x=JSON.parse(e.data);if(x.type==='agent-event')activity.unshift(x.payload);if(x.type==='message')messages.unshift(x.payload);events.innerHTML='<section><h3>Live execution</h3>'+activity.slice(0,20).map(a=>'<div class="event"><b>'+esc(a.kind)+'</b><span>'+esc(a.text)+'</span></div>').join('')+'</section><section><h3>Team communication</h3>'+messages.slice(0,20).map(m=>'<div class="event"><b>'+esc(m.from)+'</b><span>'+esc(m.text)+'</span></div>').join('')+'</section>'}`);
}

function styles() { return `:root{color-scheme:dark;--bg:#0e1013;--card:#171a1f;--line:#292e36;--text:#e8eaf0;--muted:#858d99;--purple:#8b7cf6;--green:#5ed39b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--vscode-font-family),system-ui}button,input,textarea,select{font:inherit;color:inherit}header{height:58px;padding:0 12px;display:flex;align-items:center;justify-content:space-between}header small,.war>small,.form>small{font-size:9px;letter-spacing:.12em;color:#777f8b}h2{font-size:14px;margin:3px 0}header button{border:0;background:none;color:var(--muted)}nav{height:36px;border-bottom:1px solid var(--line);display:flex;gap:15px;padding:0 12px}nav button{border:0;background:none;color:var(--muted);font-size:10px;position:relative}nav button.active{color:white}nav button.active:after{content:'';position:absolute;height:1px;background:var(--purple);left:0;right:0;bottom:0}nav i{font-style:normal;background:#2d2944;padding:1px 5px;border-radius:8px}main#content{height:calc(100vh - 224px);overflow:auto;padding:9px}.empty{height:220px;display:grid;place-content:center;justify-items:center;text-align:center;color:var(--muted)}.empty h3{color:var(--text);margin:10px 0 4px}.empty p{font-size:10px;line-height:1.5;max-width:220px;margin:0}.orb{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(145deg,#a396ff,#6552d9);font-weight:700;color:white}.orb.small{width:29px;height:29px;border-radius:8px}.composer{position:fixed;left:8px;right:8px;bottom:8px;border:1px solid var(--line);background:var(--card);border-radius:10px}.meta{height:31px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 8px}.meta select{background:none;border:0}.meta span{margin-left:auto;font-size:8px;color:var(--muted)}textarea{width:100%;height:66px;resize:none;border:0;background:none;padding:9px;outline:none}.composer footer{display:flex;padding:6px;align-items:center}.composer footer button{border:0;background:none;color:var(--muted);font-size:9px}.composer footer button:last-child{margin-left:auto;background:#6f5edb;color:#fff;padding:6px 9px;border-radius:6px}article{border:1px solid var(--line);background:var(--card);border-radius:9px;margin-bottom:8px;padding:9px}.agentTop{display:flex;gap:8px;align-items:center}.agentTop b{font-size:10px;display:block}.agentTop em{font-size:8px;color:var(--green);font-style:normal}.agentTop em.failed{color:#f2787e}article>p{font-size:10px;color:#a0a6af}.stream{border-top:1px solid var(--line);padding-top:5px;font:9px/1.4 var(--vscode-editor-font-family),monospace}.stream>div{display:grid;grid-template-columns:12px 1fr;color:#8b929d;padding:3px}.stream i{color:var(--purple);font-style:normal}.stream .stderr{color:#f2787e}.skill,.msg{padding:10px;border-bottom:1px solid var(--line)}.skill b,.msg b{font-size:10px}.skill em{float:right;font-size:8px;color:#afa5ff}.skill p,.msg p{font-size:9px;color:var(--muted)}.setup{min-height:100vh;display:grid;grid-template-columns:210px 1fr;background:radial-gradient(circle at 75% 0,#32285a55,transparent 35%),var(--bg)}.setup aside{padding:25px;border-right:1px solid var(--line)}.brand{display:flex;align-items:center;gap:9px}.brand span{width:28px;height:28px;border-radius:8px;background:linear-gradient(145deg,#a396ff,#6552d9);display:grid;place-items:center}.setup aside>p{margin-top:45px;font-size:9px;color:var(--muted);letter-spacing:.12em}.setup ol{list-style:none;padding:0}.setup li{padding:10px 0;color:#5f6772;font-size:11px}.setup li.active{color:#c8c1ff}.form{padding:55px 8vw;max-width:900px}.form h1{font-size:38px;line-height:1.08;margin:9px 0}.lead{color:var(--muted);font-size:13px;max-width:550px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.form label{display:block;font-size:10px;color:#9ca3ad;margin:12px 0}.form input{display:block;width:100%;height:40px;margin-top:6px;background:#111318;border:1px solid var(--line);border-radius:8px;padding:0 10px;outline:none}.form input:focus{border-color:#7365d3}.form h3{font-size:12px;margin:25px 0 8px}.form h3 span{font-weight:400;color:var(--muted)}.tools{display:grid;grid-template-columns:1fr 1fr;gap:9px}.tool{display:grid!important;grid-template-columns:31px 1fr auto;align-items:center;gap:9px;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:10px;margin:0!important}.tool b,.tool em{display:block}.tool em{font-size:8px;color:var(--muted);font-style:normal}.tool input{width:auto;height:auto;margin:0}.form footer{margin-top:30px;border-top:1px solid var(--line);padding-top:15px;display:flex;align-items:center}.form footer span{font-size:9px;color:var(--muted)}.form footer button{margin-left:auto;border:0;background:#6f5edb;padding:10px 14px;border-radius:8px}.war{padding:40px}.war h1{font-size:34px;margin:8px 0}.war>p{color:var(--muted)}.wargrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.wargrid section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.event{padding:8px;border-bottom:1px solid var(--line)}.event b{display:block;font-size:9px;color:#afa5ff}.event span{font-size:9px;color:var(--muted)}@media(max-width:650px){.setup{grid-template-columns:1fr}.setup aside{display:none}.form{padding:30px}.grid,.tools,.wargrid{grid-template-columns:1fr}.form h1{font-size:29px}}`; }

function activate(context) {
  const provider = new TeamViewProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('relay.teamView', provider));
  context.subscriptions.push(vscode.commands.registerCommand('relay.openOnboarding', () => openOnboarding(context)));
  context.subscriptions.push(vscode.commands.registerCommand('relay.openWarRoom', () => openWarRoom(context)));
  context.subscriptions.push(vscode.commands.registerCommand('relay.runAgent', async () => {
    const prompt = await vscode.window.showInputBox({ prompt: 'What should the agent work on?' });
    if (prompt) vscode.commands.executeCommand('relay.teamView.focus');
  }));
  setTimeout(async () => {
    try {
      const config = await api('get_config');
      if (!config.onboardingComplete) openOnboarding(context);
      else vscode.commands.executeCommand('relay.teamView.focus');
    } catch (error) {
      vscode.window.showWarningMessage(`Relay backend is starting: ${error.message || error}`);
    }
  }, 900);
}
function deactivate() {}
module.exports = { activate, deactivate };

