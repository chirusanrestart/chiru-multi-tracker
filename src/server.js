
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handleTrackerRequest, trackerStats } from './tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const TRACKERS_FILE = path.join(DATA_DIR, 'trackers.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PUBLIC_FILE = path.resolve(__dirname, '../public/index.html');
const APP_VERSION = '2.2.1';

const PORT = Number(process.env.PORT || 38147);
const BIND_HOST = process.env.BIND_HOST || '::';
const PUBLIC_TRACKER_URL = (process.env.PUBLIC_TRACKER_URL || 'http://chirusanrestart.freeddns.org:38147/announce').trim();
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

function isPublicTrackerUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.pathname === '/announce' && !parsed.username && !parsed.password;
  } catch {
    return false;
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

  // Simple endpoint to verify that the process is reachable without tracker parameters.
  if (pathname === '/healthz') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'Chiru MultiTracker',
      version: APP_VERSION,
      address: server.address()
    });
  }

  // Standard BitTorrent HTTP tracker endpoints, compatible with ordinary clients.
  if (handleTrackerRequest(req, res)) return;

  if (pathname === '/') {
    try {
      const html = await fs.readFile(PUBLIC_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch {
      return sendJSON(res, 500, { error: 'Interface web não encontrada' });
    }
  }

  if (pathname === '/api/refresh') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJSON(res, 405, { error: 'Use POST para iniciar uma verificação' });
    }
    if (checking) return sendJSON(res, 409, { error: 'Uma verificação já está em andamento', checking: true });
    await refresh();
    return sendJSON(res, 200, {
      checking,
      lastUpdate,
      total: results.length,
      online: results.filter(r => r.status === 'online').length,
      offline: results.filter(r => r.status === 'offline').length
    });
  }

  if (pathname === '/api/magnet') {
    const hash = (searchParams.get('hash') || '').trim();
    const validHex = /^[a-fA-F0-9]{40}$/.test(hash);
    const validBase32 = /^[A-Z2-7]{32}$/i.test(hash);
    if (!validHex && !validBase32) {
      return sendJSON(res, 400, { error: 'Infohash inválido. Informe 40 caracteres hexadecimais ou 32 caracteres Base32.' });
    }

    const configured = getTrackerList(await readJSON(TRACKERS_FILE, {}));
    const customTracker = isPublicTrackerUrl(PUBLIC_TRACKER_URL)
      ? [{ url: PUBLIC_TRACKER_URL, category: 'chiru' }]
      : [];
    const all = [...new Map([...customTracker, ...configured].map(t => [t.url, t])).values()];
    const onlineOnly = searchParams.get('onlineOnly') === 'true';
    const protocol = (searchParams.get('protocol') || '').toLowerCase();
    const onlineSet = new Set(results.filter(r => r.status === 'online').map(r => r.url));
    let trackers = all.filter(t => !onlineOnly || onlineSet.has(t.url) || t.url === PUBLIC_TRACKER_URL);
    if (protocol) trackers = trackers.filter(t => {
      try { return new URL(t.url).protocol.slice(0, -1) === protocol; } catch { return false; }
    });
    trackers = trackers.slice(0, 50);

    const params = new URLSearchParams();
    params.set('xt', `urn:btih:${hash}`);
    const name = searchParams.get('dn');
    if (name) params.set('dn', name.slice(0, 200));
    for (const tracker of trackers) params.append('tr', tracker.url);
    const magnet = `magnet:?${params.toString()}`;
    return sendJSON(res, 200, {
      magnet,
      count: trackers.length,
      trackers: trackers.map(t => t.url),
      onlineOnly,
      note: 'Tracker URLs are included in the magnet; this does not verify that the infohash exists or that peers are available.'
    });
  }

  if (pathname === '/api/status') {
    return sendJSON(res, 200, {
      service: 'Chiru MultiTracker',
      version: APP_VERSION,
      checking,
      lastUpdate,
      total: results.length,
      online: results.filter(r => r.status === 'online').length,
      offline: results.filter(r => r.status === 'offline').length,
      tracker: { enabled: true, announcePath: '/announce', scrapePath: '/scrape', ...trackerStats() },
      publicAnnounceUrlConfigured: isPublicTrackerUrl(PUBLIC_TRACKER_URL)
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

  if (pathname === '/api/history/summary' || pathname === '/api/ranking') {
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

    const trackers = [...summary.values()].map(item => {
      const availability = item.checks
        ? Number((item.online / item.checks * 100).toFixed(2))
        : 0;
      const averageLatency = item.latencySamples
        ? Math.round(item.latencyTotal / item.latencySamples)
        : null;
      let recommendation = 'insufficient-data';
      if (item.checks >= 12) {
        if (availability >= 80) recommendation = 'keep';
        else if (availability >= 35) recommendation = 'watch';
        else recommendation = 'retirement-candidate';
      }
      return {
        url: item.url,
        checks: item.checks,
        online: item.online,
        offline: item.offline,
        availability,
        averageLatency,
        recommendation,
        recommendationNote: {
          keep: 'Boa disponibilidade histórica; manter na lista.',
          watch: 'Disponibilidade irregular; observar mais ciclos.',
          'retirement-candidate': 'Muitas falhas no histórico; avaliar remoção após confirmar em outra rede.',
          'insufficient-data': 'Ainda não há 12 verificações para recomendar mudanças.'
        }[recommendation]
      };
    }).sort((a, b) => {
      const priority = { keep: 0, watch: 1, 'insufficient-data': 2, 'retirement-candidate': 3 };
      return priority[a.recommendation] - priority[b.recommendation]
        || b.availability - a.availability
        || (a.averageLatency ?? Number.MAX_SAFE_INTEGER) - (b.averageLatency ?? Number.MAX_SAFE_INTEGER);
    });

    return sendJSON(res, 200, {
      count: trackers.length,
      policy: 'Recomendação baseada no histórico; nenhuma URL é removida automaticamente.',
      thresholds: { minimumChecks: 12, keepAvailabilityPercent: 80, watchAvailabilityPercent: 35 },
      trackers
    });
  }

  return sendJSON(res, 404, { error: 'Rota não encontrada' });
});

let ddnsUpdater = null;
let discoveryProcess = null;
let evaluationProcess = null;
let discoveryTimer = null;
const DISCOVERY_INTERVAL = Math.max(
  60_000,
  Number(process.env.TRACKER_DISCOVERY_INTERVAL_MS || 6 * 60 * 60 * 1000)
);

function runCandidateEvaluation() {
  if (process.env.DISABLE_TRACKER_AUTO_PROMOTION === '1') {
    console.log('ℹ️ Avaliação/promoção automática desativada por DISABLE_TRACKER_AUTO_PROMOTION=1.');
    return;
  }
  if (evaluationProcess) {
    console.log('ℹ️ Avaliação de candidatos já está em andamento; execução duplicada ignorada.');
    return;
  }

  const scriptPath = path.resolve(__dirname, '../scripts/evaluate-trackers.js');
  console.log('🧪 Avaliando um lote de candidatos UDP para possível promoção...');
  evaluationProcess = spawn(process.execPath, [scriptPath], {
    stdio: 'inherit',
    env: process.env
  });
  evaluationProcess.on('error', error => {
    console.error(`❌ Não foi possível iniciar a avaliação de candidatos: ${error.message}`);
    evaluationProcess = null;
  });
  evaluationProcess.on('exit', (code, signal) => {
    if (code === 0) console.log('✅ Avaliação de candidatos concluída.');
    else console.error(`⚠️ Avaliação de candidatos terminou (código=${code}, sinal=${signal || 'nenhum'}).`);
    evaluationProcess = null;
  });
}

function runTrackerDiscovery() {
  if (process.env.DISABLE_TRACKER_DISCOVERY === '1') {
    console.log('ℹ️ Descoberta automática de trackers desativada por DISABLE_TRACKER_DISCOVERY=1.');
    return;
  }
  if (discoveryProcess) {
    console.log('ℹ️ Descoberta de trackers já está em andamento; ciclo duplicado ignorado.');
    return;
  }

  const scriptPath = path.resolve(__dirname, '../scripts/discover-trackers.js');
  console.log('🔎 Iniciando descoberta automática de novos trackers públicos...');
  discoveryProcess = spawn(process.execPath, [scriptPath], {
    stdio: 'inherit',
    env: process.env
  });

  discoveryProcess.on('error', error => {
    console.error(`❌ Não foi possível iniciar a descoberta de trackers: ${error.message}`);
    discoveryProcess = null;
  });
  discoveryProcess.on('exit', (code, signal) => {
    if (code === 0) {
      console.log('✅ Descoberta automática concluída; candidatos atualizados em data/discovered-trackers.json.');
      runCandidateEvaluation();
    }
    else console.error(`⚠️ Descoberta de trackers terminou (código=${code}, sinal=${signal || 'nenhum'}).`);
    discoveryProcess = null;
  });
}

function startTrackerDiscoveryScheduler() {
  if (process.env.DISABLE_TRACKER_DISCOVERY === '1') {
    console.log('ℹ️ Descoberta automática desativada por DISABLE_TRACKER_DISCOVERY=1.');
    return;
  }

  runTrackerDiscovery();
  discoveryTimer = setInterval(runTrackerDiscovery, DISCOVERY_INTERVAL);
  console.log(`⏱️ Descoberta automática de trackers: a cada ${Math.round(DISCOVERY_INTERVAL / 60000)} minuto(s).`);
}

function startDdnsUpdater() {
  if (process.env.DISABLE_DDNS_UPDATER === '1') {
    console.log('ℹ️ Atualizador Dynu automático desativado por DISABLE_DDNS_UPDATER=1.');
    return;
  }

  const updaterPath = path.join(__dirname, 'ddns-updater.js');
  ddnsUpdater = spawn(process.execPath, [updaterPath], {
    stdio: 'inherit',
    env: process.env
  });

  ddnsUpdater.on('error', error => {
    console.error(`❌ Não foi possível iniciar o atualizador Dynu: ${error.message}`);
  });
  ddnsUpdater.on('exit', (code, signal) => {
    if (code !== 0) {
      console.error(`⚠️ Atualizador Dynu terminou (código=${code}, sinal=${signal || 'nenhum'}). O tracker continuará rodando.`);
    }
  });
}

server.on('error', error => {
  console.error(`❌ Falha ao abrir o servidor HTTP na porta ${PORT} (bind ${BIND_HOST}): ${error.code || error.message}`);
  if (error.code === 'EADDRINUSE') console.error('➡️ A porta já está em uso por outro processo.');
  if (error.code === 'EACCES') console.error('➡️ O Android/Termux não permitiu abrir essa porta.');
  process.exitCode = 1;
});

// Bind somente em IPv6. Não aceitar sockets IPv4 nem IPv4-mapped.
server.listen({ port: PORT, host: BIND_HOST, ipv6Only: true }, async () => {
  const address = server.address();
  startDdnsUpdater();
  startTrackerDiscoveryScheduler();
  console.log(`📡 Chiru MultiTracker v${APP_VERSION} iniciado; bind=${BIND_HOST}; porta=${PORT}; endereço=${JSON.stringify(address)}`);
  console.log(`🩺 Teste local: http://127.0.0.1:${PORT}/healthz`);
  console.log(`🩺 Teste pela rede: http://IP-DO-CELULAR:${PORT}/healthz`);
  if (isPublicTrackerUrl(PUBLIC_TRACKER_URL)) console.log(`🌐 Tracker público configurado: ${PUBLIC_TRACKER_URL}`);
  else console.log('ℹ️ Configure PUBLIC_TRACKER_URL com seu endereço público /announce para incluí-lo nos magnets.');

  await refresh();
  setInterval(refresh, INTERVAL);
});
