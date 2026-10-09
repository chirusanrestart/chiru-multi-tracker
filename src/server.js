
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const TRACKERS_FILE = path.join(DATA_DIR, 'trackers.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const PORT = Number(process.env.PORT || 3000);
const INTERVAL = 5 * 60 * 1000;
const TIMEOUT = 6000;
const HISTORY_LIMIT = 288; // 24 horas, verificando a cada 5 min

let results = [];
let lastUpdate = null;
let checking = false;

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

function getTrackerList(data) {
  return Object.entries(data).flatMap(([category, urls]) =>
    Array.isArray(urls)
      ? urls.map(url => ({ url, category }))
      : []
  );
}

function udpCheck(host, port) {
  return new Promise(resolve => {
    let socket;
    let timer;
    let done = false;

    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);

      try {
        socket?.close();
      } catch {}

      resolve(result);
    };

    timer = setTimeout(
      () => finish({ online: false, error: 'timeout' }),
      TIMEOUT
    );

    (async () => {
      try {
        const addresses = await dns.lookup(host, { family: 4 });
        if (done) return;

        socket = dgram.createSocket('udp4');

        const transactionId = crypto.randomBytes(4);
        const packet = Buffer.alloc(16);

        packet.writeBigUInt64BE(0x41727101980n, 0);
        packet.writeUInt32BE(0, 8);
        transactionId.copy(packet, 12);

        socket.on('error', error => {
          finish({ online: false, error: error.message });
        });

        socket.on('message', message => {
          if (message.length < 8) return;

          const action = message.readUInt32BE(0);
          const receivedId = message.subarray(4, 8);

          if (!receivedId.equals(transactionId)) return;

          if (action === 0) {
            finish({ online: true });
          } else if (action === 3) {
            finish({
              online: false,
              error: message.subarray(8).toString() || 'tracker error'
            });
          }
        });

        socket.send(packet, port, addresses.address, error => {
          if (error) finish({ online: false, error: error.message });
        });
      } catch (error) {
        finish({ online: false, error: error.message });
      }
    })();
  });
}

async function checkTracker(item) {
  const start = Date.now();

  try {
    const parsed = new URL(item.url);
    let result;

    if (parsed.protocol === 'udp:') {
      result = await udpCheck(parsed.hostname, Number(parsed.port || 80));
    } else if (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:'
    ) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT);

      try {
        const response = await fetch(
          `${parsed.origin}${parsed.pathname}`,
          {
            method: 'GET',
            signal: controller.signal,
            redirect: 'manual'
          }
        );

        // HTTP resposta indica acessibilidade, não garante announce válido.
        result = {
          online: response.status < 500 && ![404, 410].includes(response.status),
          httpStatus: response.status,
          note: 'HTTP reachability only; announce not validated',
          ...([404, 410].includes(response.status)
            ? { error: 'endpoint não encontrado' }
            : {})
        };
      } finally {
        clearTimeout(timer);
      }
    } else {
      result = { online: false, error: 'protocolo não suportado' };
    }

    return {
      ...item,
      protocol: parsed.protocol.replace(':', ''),
      status: result.online ? 'online' : 'offline',
      latency: Date.now() - start,
      checkedAt: new Date().toISOString(),
      ...result
    };
  } catch (error) {
    return {
      ...item,
      protocol: 'unknown',
      status: 'offline',
      latency: Date.now() - start,
      checkedAt: new Date().toISOString(),
      error: error.message
    };
  }
}

async function saveHistory() {
  const storedHistory = await readJSON(HISTORY_FILE, []);
  const history = Array.isArray(storedHistory) ? storedHistory : [];

  history.push({
    timestamp: lastUpdate,
    total: results.length,
    online: results.filter(r => r.status === 'online').length,
    offline: results.filter(r => r.status === 'offline').length,
    trackers: results.map(r => ({
      url: r.url,
      category: r.category,
      status: r.status,
      latency: r.latency
    }))
  });

  await writeJSON(HISTORY_FILE, history.slice(-HISTORY_LIMIT));
}

async function refresh() {
  if (checking) return;

  checking = true;
  console.log('🔎 Verificando trackers...');

  try {
    const data = await readJSON(TRACKERS_FILE, {});
    const trackers = getTrackerList(data);
    const unique = [...new Map(trackers.map(t => [t.url, t])).values()];

    const nextResults = [];

    // Verifica 5 por vez para evitar sobrecarregar o aparelho/rede.
    for (let i = 0; i < unique.length; i += 5) {
      const batch = unique.slice(i, i + 5);
      const checked = await Promise.all(batch.map(checkTracker));
      nextResults.push(...checked);
    }

    results = nextResults;
    lastUpdate = new Date().toISOString();

    await saveHistory();

    const online = results.filter(r => r.status === 'online').length;
    console.log(`✅ ${online}/${results.length} trackers online`);
  } catch (error) {
    console.error('❌ Erro na verificação:', error.message);
  } finally {
    checking = false;
  }
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJSON(res, 400, { error: 'URL de requisição inválida' });
  }
  const { pathname, searchParams } = url;

  if (pathname === '/') {
    return sendJSON(res, 200, {
      name: 'Chiru MultiTracker',
      version: '2.1.0',
      endpoints: [
        '/api/status',
        '/api/trackers',
        '/api/list',
        '/api/history',
        '/api/history/summary'
      ]
    });
  }

  if (pathname === '/api/status') {
    return sendJSON(res, 200, {
      service: 'Chiru MultiTracker',
      version: '2.1.0',
      checking,
      lastUpdate,
      total: results.length,
      online: results.filter(r => r.status === 'online').length,
      offline: results.filter(r => r.status === 'offline').length
    });
  }

  if (pathname === '/api/trackers') {
    let list = [...results];

    const category = searchParams.get('category');
    const status = searchParams.get('status');
    const protocol = searchParams.get('protocol');

    if (category) list = list.filter(r => r.category === category);
    if (status) list = list.filter(r => r.status === status);
    if (protocol) {
      list = list.filter(r => r.protocol === protocol.toLowerCase());
    }

    list.sort((a, b) => a.latency - b.latency);
    return sendJSON(res, 200, { count: list.length, trackers: list });
  }

  if (pathname === '/api/list') {
    const protocol = searchParams.get('protocol');

    const list = results
      .filter(r => r.status === 'online')
      .filter(r => !protocol || r.protocol === protocol.toLowerCase())
      .sort((a, b) => a.latency - b.latency)
      .map(r => r.url);

    return sendJSON(res, 200, { count: list.length, trackers: list });
  }

  if (pathname === '/api/history') {
    const storedHistory = await readJSON(HISTORY_FILE, []);
    const history = Array.isArray(storedHistory) ? storedHistory : [];
    const requested = Number.parseInt(searchParams.get('limit') || '24', 10);
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(requested, HISTORY_LIMIT))
      : 24;

    return sendJSON(res, 200, {
      count: Math.min(history.length, limit),
      retained: history.length,
      history: history.slice(-limit)
    });
  }

  if (pathname === '/api/history/summary') {
    const storedHistory = await readJSON(HISTORY_FILE, []);
    const history = Array.isArray(storedHistory) ? storedHistory : [];
    const summary = new Map();

    for (const snapshot of history) {
      for (const tracker of snapshot.trackers || []) {
        if (!summary.has(tracker.url)) {
          summary.set(tracker.url, {
            url: tracker.url,
            checks: 0,
            online: 0,
            offline: 0,
            latencyTotal: 0,
            latencySamples: 0
          });
        }

        const item = summary.get(tracker.url);
        item.checks++;

        if (tracker.status === 'online') item.online++;
        else item.offline++;

        if (tracker.status === 'online' && Number.isFinite(tracker.latency)) {
          item.latencyTotal += tracker.latency;
          item.latencySamples++;
        }
      }
    }

    const trackers = [...summary.values()].map(item => ({
      ...item,
      availability: item.checks
        ? Number((item.online / item.checks * 100).toFixed(2))
        : 0,
      averageLatency: item.latencySamples
        ? Math.round(item.latencyTotal / item.latencySamples)
        : null
    })).sort((a, b) => b.availability - a.availability);

    return sendJSON(res, 200, { count: trackers.length, trackers });
  }

  return sendJSON(res, 404, { error: 'Rota não encontrada' });
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`📡 Chiru MultiTracker v2.1 em http://localhost:${PORT}`);

  await refresh();
  setInterval(refresh, INTERVAL);
});
