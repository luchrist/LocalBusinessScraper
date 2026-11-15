// Private VPS adapter for the website's five-result demo. Never included in installers.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const token = process.env.AUTOSETTER_DEMO_TOKEN;
if (!token || !process.env.AUTOSETTER_LOCAL_TOKEN || !process.env.MAILGUN_API_KEY) throw new Error('Demo configuration incomplete');
const root = process.cwd(), output = path.join(process.env.AUTOSETTER_DATA_DIR, 'demo-downloads');
await fs.mkdir(output, { recursive: true });
const internal = 'http://127.0.0.1:3202';
const child = spawn(process.execPath, ['.next/standalone/server.js'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: '3202' },
});
child.on('exit', code => process.exit(code || 1));
const localHeaders = { 'x-autosetter-local-token': process.env.AUTOSETTER_LOCAL_TOKEN };
const local = (endpoint, options = {}) => fetch(internal + endpoint, { ...options, headers: { ...localHeaders, ...options.headers } });
let running = false;
const cell = value => '"' + String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const authenticated = req => {
  const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};

const server = createServer(async (req, res) => {
  if (!authenticated(req)) return json(res, 403, { error: 'Forbidden' });
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const state = await local('/api/settings/model/setup').then(r => r.json());
      return json(res, state.status === 'ready' ? 200 : 503, { ready: state.status === 'ready', busy: running, model: state.model, received: state.received, total: state.total });
    }
    if (req.method === 'GET' && /^\/downloads\/[a-f0-9-]{36}\.csv$/.test(url.pathname)) {
      const file = path.join(output, path.basename(url.pathname));
      const info = await fs.stat(file);
      if (Date.now() - info.mtimeMs > 7 * 86400_000) { await fs.rm(file); return json(res, 404, { error: 'Expired' }); }
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': data.length }); return res.end(data);
    }
    if (req.method !== 'POST' || url.pathname !== '/api/generate-leads') return json(res, 404, { error: 'Not found' });
    if (running) return json(res, 503, { error: 'Der Live-Test ist gerade beschäftigt. Bitte versuche es in wenigen Minuten erneut.' });
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 10000) return json(res, 400, { error: 'Invalid request' }); }
    const { city, industry, emailTo } = JSON.parse(raw);
    if (![city, industry].every(s => typeof s === 'string' && s.trim().length > 1 && s.length <= 120) || typeof emailTo !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo) || emailTo.length > 254) return json(res, 400, { error: 'Bitte prüfe Stadt, Branche und E-Mail-Adresse.' });
    running = true;
    let sessionId;
    try {
      const form = new FormData();
      form.set('file', new Blob(['Stadt,Branche\n' + [city, industry].map(cell).join(',')], { type: 'text/csv' }), 'demo.csv');
      for (const [key, value] of Object.entries({ maxBusinesses: '5', searchEmail: 'true', searchOwner: 'true', singleWorker: 'true', enrichmentWorkerCount: '1', country: 'de' })) form.set(key, value);
      const response = await local('/api/scrape', { method: 'POST', body: form, signal: AbortSignal.timeout(240_000) });
      if (!response.ok) throw new Error('Der Live-Test wird vorbereitet. Bitte versuche es gleich erneut.');
      const reader = response.body.getReader(), decoder = new TextDecoder(), results = [];
      let pending = '', complete = false;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        const events = pending.split('\n\n'); pending = events.pop();
        for (const event of events) {
          if (!event.startsWith('data: ')) continue;
          const data = JSON.parse(event.slice(6));
          if (data.sessionId) sessionId = data.sessionId;
          if (data.type === 'error') throw new Error('Die Recherche konnte nicht abgeschlossen werden. Bitte versuche es erneut.');
          if (data.type === 'result') results.push(data.result);
          if (data.type === 'complete') complete = true;
        }
      }
      if (!complete || !results.length) throw new Error('Für diese Suche wurden keine Ergebnisse gefunden. Bitte versuche eine andere Stadt oder Branche.');
      const keys = ['name', 'adresse', 'telefon', 'website', 'email', 'owner', 'stadt', 'branche'];
      const csv = '\uFEFF' + [['Unternehmen', 'Adresse', 'Telefon', 'Website', 'E-Mail', 'Inhaber', 'Stadt', 'Branche'], ...results.slice(0, 5).map(r => keys.map(k => r[k]))].map(row => row.map(cell).join(';')).join('\r\n');
      const fileName = randomUUID() + '.csv';
      await fs.writeFile(path.join(output, fileName), csv, { mode: 0o600 });
      const downloadUrl = 'https://www.autosetter.de/api/downloads/' + fileName;
      const message = new FormData();
      message.set('from', process.env.MAILGUN_FROM || 'Luca von AutoSetter <luca@autosetter.de>');
      message.set('to', emailTo); message.set('subject', 'Dein AutoSetter Live-Test');
      message.set('text', `Hallo,\n\nhier sind deine ${results.length} kostenlosen Beispiel-Ergebnisse für ${industry} in ${city}. Die CSV-Datei findest du im Anhang und für sieben Tage hier:\n${downloadUrl}\n\nAutoSetter für deinen Computer: https://www.autosetter.de\n\nViele Grüße\nLuca`);
      message.set('attachment', new Blob([csv], { type: 'text/csv' }), 'AutoSetter-Live-Test.csv');
      message.set('o:tracking', 'no');
      if (req.headers['x-autosetter-test-mode'] === 'true') message.set('o:testmode', 'yes');
      const mail = await fetch(`https://api.eu.mailgun.net/v3/${process.env.MAILGUN_DOMAIN || 'mg.autosetter.de'}/messages`, {
        method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('api:' + process.env.MAILGUN_API_KEY).toString('base64') }, body: message, signal: AbortSignal.timeout(20_000),
      });
      if (!mail.ok) throw new Error('Der E-Mail-Versand ist momentan nicht verfügbar. Bitte versuche es erneut.');
      return json(res, 200, { success: true, count: results.length, downloadUrl });
    } catch (error) {
      if (sessionId) await local('/api/scrape/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }).catch(() => {});
      return json(res, 502, { error: error.name === 'TimeoutError' ? 'Die Recherche hat zu lange gedauert. Bitte versuche es erneut.' : error.message });
    } finally { running = false; }
  } catch { json(res, 400, { error: 'Invalid request' }); }
});
server.listen(3201, '127.0.0.1');
const setup = setInterval(async () => {
  try { const state = await local('/api/settings/model/setup', { method: 'POST' }).then(r => r.json()); if (state.status === 'ready') clearInterval(setup); } catch { /* Wait for the internal Next server. */ }
}, 10_000);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); child.kill(signal); setTimeout(() => process.exit(0), 3000).unref(); });
