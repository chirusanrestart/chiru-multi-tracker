import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'ddns-last-ip.json');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function intervalMs() {
  return positiveInteger(process.env.DDNS_UPDATE_INTERVAL_MS, 5 * 60 * 1000);
}

function timeoutMs() {
  return positiveInteger(process.env.DDNS_TIMEOUT_MS, 10000);
}

async function loadEnvFile() {
  try {
    const content = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, '').trim();
      }
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function isGlobalIPv6(value) {
  if (net.isIP(value) !== 6) return false;
  const ip = value.toLowerCase().split('%')[0];
  return /^[23][0-9a-f]{0,3}:/i.test(ip) && !ip.startsWith('::ffff:');
}

async function fetchIPv6(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(endpoint, {
      headers: { accept: 'text/plain' },
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const address = (await response.text()).trim().split(/\s+/)[0];
    if (!isGlobalIPv6(address)) throw new Error('a resposta não contém um IPv6 global válido');
    return address;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverIPv6() {
  const sources = ['https://api6.ipify.org', 'https://ipv6.icanhazip.com'];
  const results = await Promise.allSettled(sources.map(fetchIPv6));
  const addresses = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn(`⚠️ Uma API IPv6 falhou: ${result.reason?.message || 'erro desconhecido'}`);
    }
  }
  if (addresses.length === 0) throw new Error('nenhuma API conseguiu detectar um IPv6 global');
  if (new Set(addresses).size > 1) {
    throw new Error('as APIs retornaram IPv6 diferentes; atualização cancelada por segurança');
  }
  if (addresses.length === 1) console.warn('⚠️ Só uma API respondeu; usando o resultado disponível.');
  return addresses[0];
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.warn('⚠️ Estado anterior inválido; será recriado.');
    return {};
  }
}

function getDynuConfig() {
  const hostname = (process.env.DDNS_HOST || '').trim();
  const username = (process.env.DDNS_USERNAME || '').trim();
  const password = process.env.DDNS_PASSWORD || '';
  if (!hostname || !username || !password) {
    throw new Error('configure DDNS_HOST, DDNS_USERNAME e DDNS_PASSWORD no .env local');
  }
  return { hostname, username, password };
}

async function updateDynu(ip) {
  const { hostname, username, password } = getDynuConfig();
  const url = new URL('https://api.dynu.com/nic/update');
  url.searchParams.set('hostname', hostname);
  url.searchParams.set('username', username);
  url.searchParams.set('password', password);
  url.searchParams.set('myip', 'no');
  url.searchParams.set('myipv6', ip);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/plain' },
      signal: controller.signal,
      redirect: 'error'
    });
    const body = (await response.text()).trim();
    if (!response.ok) throw new Error(`Dynu respondeu HTTP ${response.status}`);
    if (/^(good|nochg)(?:\s|$)/i.test(body)) return body;
    if (/^badauth\b/i.test(body)) throw new Error('Dynu recusou a autenticação; confira o usuário e a senha local');
    if (/^nohost\b/i.test(body)) throw new Error('Dynu não reconheceu o hostname configurado');
    if (/^911\b/i.test(body)) throw new Error('Dynu informou erro interno temporário (911)');
    throw new Error(`resposta inesperada do Dynu: ${body.slice(0, 100) || 'vazia'}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function runOnce() {
  const ip = await discoverIPv6();
  const previous = await readState();

  // Sempre sincroniza com o Dynu, mesmo quando o IPv6 parece igual ao último
  // salvo localmente. Isso corrige um registro DNS desatualizado no próximo ciclo.
  // Se já estiver correto, o Dynu responde "nochg".
  const response = await updateDynu(ip);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify({
    ipv6: ip,
    updatedAt: new Date().toISOString(),
    dynuResponse: response.split(/\s+/)[0]
  }, null, 2) + '\n', { mode: 0o600 });

  const changed = previous.ipv6 !== ip;
  const action = response.split(/\s+/)[0].toLowerCase() === 'nochg'
    ? 'registro já estava sincronizado'
    : 'registro atualizado';
  console.log(\`✅ Dynu verificado: IPv6 \${ip}; \${action}; \${changed ? 'IP mudou' : 'IP igual ao ciclo anterior'}; próxima verificação em \${Math.round(intervalMs() / 60000)} min.\`);
}
async function main() {
  await loadEnvFile();
  console.log('🛰️ Chiru MultiTracker: atualizador IPv6/Dynu iniciado.');

  try {
    getDynuConfig();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (error) {
      console.error(`❌ Falha no ciclo Dynu: ${error.message}`);
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(tick, intervalMs());
}

main().catch(error => {
  console.error(`❌ Atualizador não iniciou: ${error.message}`);
  process.exitCode = 1;
});
