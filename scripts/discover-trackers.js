import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACKERS_FILE = path.join(ROOT, 'data', 'trackers.json');
const OUTPUT_FILE = path.join(ROOT, 'data', 'discovered-trackers.json');
const SOURCES = [
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_udp.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_http.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_https.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_all.txt'
];
const TIMEOUT_MS = 10000;

function normalizeTracker(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  // Rejeita entradas malformadas como "udp://http//host" antes de URL() aceitar um hostname enganoso.
  if (!input || /^(udp|https?):\/\/https?\/\//i.test(input)) return null;
  try {
    const url = new URL(input);
    if (!['udp:', 'http:', 'https:'].includes(url.protocol)) return null;
    if (!url.hostname || url.username || url.password) return null;
    if (url.hostname.includes('/') || /\s/.test(url.hostname)) return null;
    // Caminhos repetidos não acrescentam informação e criam duplicatas difíceis de comparar.
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    if (!url.pathname || url.pathname === '/') url.pathname = '/announce';
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function fetchText(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(source, {
      signal: controller.signal,
      headers: { 'user-agent': 'Chiru-MultiTracker-discovery/1.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const activeData = JSON.parse(await fs.readFile(TRACKERS_FILE, 'utf8'));
  const active = new Set(
    Object.values(activeData).flatMap(list => Array.isArray(list) ? list : [])
      .map(normalizeTracker).filter(Boolean)
  );
  const found = new Map();
  const sourceStats = [];

  for (const source of SOURCES) {
    try {
      const text = await fetchText(source);
      let count = 0;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        const candidate = normalizeTracker(line);
        if (!candidate || active.has(candidate)) continue;
        if (!found.has(candidate)) found.set(candidate, new Set());
        found.get(candidate).add(source);
        count++;
      }
      sourceStats.push({ source, status: 'ok', lines: count });
      console.log(`✓ ${source}: ${count} candidatos novos nesta fonte`);
    } catch (error) {
      sourceStats.push({ source, status: 'error', error: error.message });
      console.warn(`! ${source}: ${error.message}`);
    }
  }

  const sourceRank = new Map(SOURCES.map((source, index) => [source, index]));
  const candidates = [...found.entries()]
    .map(([url, sources]) => ({
      url,
      sources: [...sources],
      // Menor índice = fonte preferida. Listas "best" vêm antes das listas gerais/comunitárias.
      sourcePriority: Math.min(...[...sources].map(source => sourceRank.get(source) ?? 999)),
      sourceCount: sources.size
    }))
    .sort((a, b) =>
      a.sourcePriority - b.sourcePriority
      || b.sourceCount - a.sourceCount
      || a.url.localeCompare(b.url)
    )
    .map(({ sourcePriority, sourceCount, ...candidate }) => candidate);
  const output = {
    generatedAt: new Date().toISOString(),
    activeCount: active.size,
    candidateCount: candidates.length,
    note: 'Candidatos ordenados por qualidade presumida da fonte; ainda não validados por announce real. Revise e teste antes de adicionar a data/trackers.json.',
    sources: sourceStats,
    candidates
  };
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`\nConcluído: ${active.size} trackers ativos, ${candidates.length} candidatos novos.`);
  console.log(`Arquivo salvo em: ${path.relative(ROOT, OUTPUT_FILE)}`);
  console.log('Nenhum tracker foi ativado automaticamente.');
}

main().catch(error => {
  console.error('Falha na descoberta:', error.message);
  process.exitCode = 1;
});
