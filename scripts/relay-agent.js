#!/usr/bin/env node
const http = require('http');

const [type, ...raw] = process.argv.slice(2);
if (!type) {
  console.error('Usage: relay-agent <action> --key value');
  process.exit(2);
}
const payload = {};
for (let i = 0; i < raw.length; i += 2) {
  const key = raw[i]?.replace(/^--/, '');
  if (!key) continue;
  let value = raw[i + 1] ?? true;
  if (value === 'true') value = true;
  if (value === 'false') value = false;
  if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
  payload[key] = value;
}
const body = JSON.stringify({ command: 'coordination_action', args: { type, payload, actor: process.env.RELAY_AGENT_ID || payload.agentId || 'agent-cli' } });
const url = new URL(process.env.RELAY_BACKEND_URL || 'http://127.0.0.1:4173');
const request = http.request({ hostname: url.hostname, port: url.port || 80, path: '/api/invoke', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
  let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk); response.on('end', () => {
    try { const result = JSON.parse(text); if (!result.ok) throw new Error(result.error); console.log(JSON.stringify(result.result, null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  });
});
request.on('error', error => { console.error(error.message); process.exitCode = 1; });
request.end(body);
