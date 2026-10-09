import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'ddns-last-ip.json');
const INTERVAL_MS = positiveInteger(process.env.DDNS_UPDATE_INTERVAL_MS, 5 * 60 * 1000);
const TIMEOUT_MS = positiveInteger(process.env.DDNS_TIMEOUT_MS, 10000);
const UPDATE_URL = (process.env.DDNS_IPV6_UPDATE_URL || '').trim();

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
  // Global unicast IPv6 addresses are in 2000::/3. Reject private,
  // link-local, loopback, multicast, and unspecified addresses.
  return /^[23][0-9a-f]{0,3}:/i.test(ip) && !ip.startsWith('::ffff:');
}

async function fetchIPv6(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
  const sources = [
    'https://api6.ipify.org',
    'https://ipv6.icanhazip.com'
  ];
  const results = await Promise.allSettled(sources.map(fetchIPv6));
  const addresses = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  for (const result of results) {
    if (result.status === 'rejected') console.warn(`⚠️ Uma API IPv6 falhou: ${result.reason?.message || 'erro desconhecido'}`);
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

async function updateDDNS(ip) {
  if (!UPDATE_URL) {
    throw new Error('configure DDNS_IPV6_UPDATE_URL no .env com a URL oficial de atualização do provedor');
  }

  let url;
  try {
    url = new URL(UPDATE_URL.replaceAll('{ip}', encodeURIComponent(ip)));
  } catch {
    throw new Error('DDNS_IPV6_UPDATE_URL não é uma URL válida');
  }
  if (url.protocol !== 'https:') {
    throw new Error('por segurança, DDNS_IPV6_UPDATE_URL precisa usar HTTPS');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/plain, application/json' },
      signal: controller.signal,
      redirect: 'error'
    });
    const body = (await response.text()).slice(0, 500);
    if (!response.ok) throw new Error(`o provedor respondeu HTTP ${response.status}`);
    if (/\b(error|failed|invalid token|badauth|nohost)\b/i.test(body)) {
      throw new Error('o provedor indicou falha na atualização; confira a URL/token no painel oficial');
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function runOnce() {
  const ip = await discoverIPv6();
  const previous = await readState();
  if (previous.ipv6 === ip && previous.updatedAt) {
    console.log(`ℹ️ IPv6 não mudou (${ip}); sem chamada ao DDNS.`);
    return;
  }

  // The provider URL may use {ip} if it accepts an explicit address.
  // Without that placeholder, the provider may infer the request's source IP.
  const response = await updateDDNS(ip);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify({
    ipv6: ip,
    updatedAt: new Date().toISOString()
  }, null, 2) + '\n', { mode: 0o600 });

  console.log(`✅ DDNS atualizado para ${ip} em ${new Date().toISOString()}.`);
  if (response.trim()) console.log('📨 O provedor respondeu à atualização (conteúdo omitido dos logs por segurança).');
}

async function main() {
  await loadEnvFile();
  console.log('🛰️ Chiru MultiTracker: atualizador IPv6/DDNS iniciado.');
  if (!process.env.DDNS_IPV6_UPDATE_URL) {
    console.error('❌ Falta DDNS_IPV6_UPDATE_URL no .env. Nenhuma credencial será enviada.');
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
      console.error(`❌ Falha no ciclo DDNS: ${error.message}`);
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(tick, INTERVAL_MS);
}

main().catch(error => {
  console.error(`❌ Atualizador não iniciou: ${error.message}`);
  process.exitCode = 1;
});
