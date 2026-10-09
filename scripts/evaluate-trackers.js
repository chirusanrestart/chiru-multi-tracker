import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CANDIDATES_FILE = path.join(DATA, 'discovered-trackers.json');
const ACTIVE_FILE = path.join(DATA, 'trackers.json');
const HISTORY_FILE = path.join(DATA, 'candidate-history.json');
const BATCH_SIZE = Math.max(1, Math.min(50, Number(process.env.TRACKER_CANDIDATE_BATCH || 20)));
const MAX_PROMOTE = Math.max(0, Math.min(20, Number(process.env.TRACKER_MAX_PROMOTE || 5)));
const TIMEOUT_MS = 4000;
const REQUIRED_SUCCESSES = 2;

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

function udpHandshake(value) {
  return new Promise(async resolve => {
    let socket;
    let timer;
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      resolve(result);
    };

    timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), TIMEOUT_MS);
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'udp:' || !parsed.hostname) {
        return finish({ ok: false, error: 'not-udp' });
      }
      const port = Number(parsed.port || 80);
      const address = await dns.lookup(parsed.hostname, { family: 4 });
      if (done) return;
      socket = dgram.createSocket('udp4');
      const transaction = crypto.randomBytes(4);
      const packet = Buffer.alloc(16);
      packet.writeBigUInt64BE(0x41727101980n, 0);
      packet.writeUInt32BE(0, 8);
      transaction.copy(packet, 12);

      socket.on('error', error => finish({ ok: false, error: error.message }));
      socket.on('message', message => {
        if (message.length < 8 || !message.subarray(4, 8).equals(transaction)) return;
        const action = message.readUInt32BE(0);
        if (action === 0 && message.length >= 16) finish({ ok: true });
        else if (action === 3) finish({ ok: false, error: message.subarray(8).toString() || 'tracker-error' });
      });
      socket.send(packet, port, address.address, error => {
        if (error) finish({ ok: false, error: error.message });
      });
    } catch (error) {
      finish({ ok: false, error: error.message });
    }
  });
}

async function main() {
  const discovered = await readJSON(CANDIDATES_FILE, null);
  if (!discovered || !Array.isArray(discovered.candidates)) {
    console.log('Nenhuma lista de candidatos encontrada. Rode npm run discover primeiro.');
    return;
  }
  const activeData = await readJSON(ACTIVE_FILE, {});
  const historyData = await readJSON(HISTORY_FILE, { version: 1, cursor: 0, trackers: {} });
  const active = new Set(Object.values(activeData).flatMap(v => Array.isArray(v) ? v : []));
  const candidates = discovered.candidates
    .map(item => typeof item === 'string' ? { url: item } : item)
    .filter(item => typeof item.url === 'string' && item.url.startsWith('udp://') && !active.has(item.url));
  if (!candidates.length) {
    console.log('Nenhum candidato UDP novo para avaliar.');
    return;
  }

  const start = Number.isInteger(historyData.cursor) ? historyData.cursor % candidates.length : 0;
  const batch = Array.from({ length: Math.min(BATCH_SIZE, candidates.length) },
    (_, i) => candidates[(start + i) % candidates.length]);
  const nextHistory = historyData.trackers && typeof historyData.trackers === 'object' ? historyData.trackers : {};
  let passed = 0;

  for (const candidate of batch) {
    const result = await udpHandshake(candidate.url);
    const previous = nextHistory[candidate.url] || { checks: 0, successes: 0, consecutiveSuccesses: 0 };
    previous.checks++;
    previous.lastCheckedAt = new Date().toISOString();
    previous.lastResult = result.ok ? 'udp-connect-ok' : 'failed';
    previous.lastError = result.ok ? null : result.error;
    previous.consecutiveSuccesses = result.ok ? (previous.consecutiveSuccesses || 0) + 1 : 0;
    previous.successes = (previous.successes || 0) + (result.ok ? 1 : 0);
    nextHistory[candidate.url] = previous;
    if (result.ok) passed++;
    console.log(`${result.ok ? '✓' : '×'} ${candidate.url} ${result.ok ? 'UDP connect respondeu' : result.error}`);
  }

  // Only promote UDP endpoints after successful handshakes in two separate runs.
  const eligible = candidates.filter(item => {
    const h = nextHistory[item.url];
    return h && h.consecutiveSuccesses >= REQUIRED_SUCCESSES && !active.has(item.url);
  }).slice(0, MAX_PROMOTE);

  if (eligible.length) {
    if (!Array.isArray(activeData.geral)) activeData.geral = [];
    for (const item of eligible) {
      if (!activeData.geral.includes(item.url)) activeData.geral.push(item.url);
      active.add(item.url);
      console.log(`★ Promovido para geral: ${item.url}`);
    }
    await fs.writeFile(ACTIVE_FILE, JSON.stringify(activeData, null, 2) + '\n');
  }

  await fs.writeFile(HISTORY_FILE, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    cursor: (start + batch.length) % candidates.length,
    batchSize: BATCH_SIZE,
    requiredConsecutiveSuccesses: REQUIRED_SUCCESSES,
    trackers: nextHistory
  }, null, 2) + '\n');

  console.log(`\nAvaliação concluída: ${passed}/${batch.length} responderam ao handshake UDP.`);
  console.log(`Promovidos nesta execução: ${eligible.length}. Máximo por execução: ${MAX_PROMOTE}.`);
  console.log('HTTP/HTTPS permanecem candidatos: uma resposta HTTP simples não comprova um announce BitTorrent válido.');
}
main().catch(error => {
  console.error('Falha ao avaliar candidatos:', error.message);
  process.exitCode = 1;
});
