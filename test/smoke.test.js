import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const trackers = JSON.parse(await readFile(new URL('../data/trackers.json', import.meta.url), 'utf8'));
const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');

test('package metadata and scripts are configured', () => {
  assert.equal(packageJson.name, 'chiru-multi-tracker');
  assert.match(packageJson.version, /^2\.1\.\d+$/);
  assert.equal(packageJson.type, 'module');
  assert.ok(packageJson.scripts.start);
  assert.ok(packageJson.scripts.check);
  assert.ok(packageJson.scripts.test);
});

test('tracker configuration contains arrays of valid, unique URLs', () => {
  assert.ok(trackers && typeof trackers === 'object' && !Array.isArray(trackers));
  const urls = Object.values(trackers).flat();
  assert.ok(urls.length >= 50, 'the public tracker pool should remain substantial');
  assert.equal(new Set(urls).size, urls.length, 'tracker URLs should be unique');

  for (const url of urls) {
    assert.equal(typeof url, 'string');
    const parsed = new URL(url);
    assert.ok(['udp:', 'http:', 'https:'].includes(parsed.protocol), url);
    assert.ok(parsed.hostname, url);
  }
});

test('server exposes the documented API endpoints', () => {
  for (const endpoint of [
    '/api/status',
    '/api/trackers',
    '/api/list',
    '/api/history',
    '/api/history/summary'
  ]) {
    assert.ok(server.includes(endpoint), `missing endpoint: ${endpoint}`);
  }
});

test('UDP health check validates the transaction ID', () => {
  assert.ok(server.includes('receivedId.equals(transactionId)'));
  assert.ok(server.includes('action === 0'));
});

test('HTTP checks disclose that announce is not validated', () => {
  assert.ok(server.includes('announce not validated'));
  assert.ok(server.includes('![404, 410].includes(response.status)'));
});

test('dashboard and test helpers are present', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /Gerar magnet link/);
  assert.match(html, /Verificar agora/);
  assert.ok(server.includes("pathname === '/api/magnet'"));
  assert.ok(server.includes("pathname === '/api/refresh'"));
  assert.ok(server.includes('validHex'));
  assert.ok(server.includes('URLSearchParams'));
});
