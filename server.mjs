// Serveur local : sert l'interface HTML et pilote le parcours Playwright.
//
//   node server.mjs          -> http://localhost:3000
//   PORT=8080 node server.mjs
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Workflow } from './lib/session.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const workflow = new Workflow();

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Corps de requête JSON invalide.');
  }
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    const type =
      ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.svg' ? 'image/svg+xml'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (pathname === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, workflow.snapshot());
  }

  if (pathname.startsWith('/api/')) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Méthode non autorisée.' });
    // Une seule action à la fois (le navigateur est un état partagé).
    if (workflow._busy) return sendJson(res, 409, { error: 'Une action est déjà en cours.' });
    workflow._busy = true;
    try {
      let out;
      switch (pathname) {
        case '/api/reset':
          out = await workflow.reset();
          break;
        case '/api/load':
          out = await workflow.loadStored();
          break;
        case '/api/request-email': {
          const { email } = await readBody(req);
          out = await workflow.requestEmail(email);
          break;
        }
        case '/api/confirm-link': {
          const { link } = await readBody(req);
          out = await workflow.confirmLink(link);
          break;
        }
        case '/api/generate-key':
          out = await workflow.generateKey();
          break;
        default:
          return sendJson(res, 404, { error: 'Route inconnue.' });
      }
      return sendJson(res, 200, out);
    } catch (err) {
      return sendJson(res, 500, { error: String(err?.message ?? err), ...workflow.snapshot() });
    } finally {
      workflow._busy = false;
    }
  }

  return serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Interface Source Library : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
});

const shutdown = async () => {
  await workflow.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);