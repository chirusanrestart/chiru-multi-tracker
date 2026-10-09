import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const trackers = JSON.parse(await readFile(new URL('../data/trackers.json', import.meta.url), 'utf8'));
const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');

test('package metadata and scripts are configured', () => {
  assert.equal(packageJson.name, 'chiru-multi-tracker');
  assert.match(packageJson.version, /^2\.\d+\.\d+$/);
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


test('HTTP tracker implements announce and scrape endpoints', async () => {
  const tracker = await readFile(new URL('../src/tracker.js', import.meta.url), 'utf8');
  assert.ok(tracker.includes("pathname !== '/announce' && pathname !== '/scrape'"));
  assert.ok(tracker.includes('peers6:'));
  assert.ok(tracker.includes("'failure reason'"));
  assert.ok(tracker.includes("files.set(hash"));
});

test('tracker bencode preserves binary dictionary keys and raw query bytes', async () => {
  const { trackerInternals } = await import('../src/tracker.js');
  const query = trackerInternals.parseRawQuery('/announce?info_hash=%00%FF%7F&peer_id=%41%42');
  assert.deepEqual(query.get('info_hash'), Buffer.from([0, 255, 127]));
  assert.deepEqual(query.get('peer_id'), Buffer.from([65, 66]));
  const encoded = trackerInternals.bencode(new Map([[Buffer.from([0, 255]), { complete: 1 }]]));
  assert.ok(encoded.includes(Buffer.from([0, 255])));
  assert.equal(encoded[0], 0x64); // d
});

test('tracker announce returns compact peers to a second peer', async () => {
  const { handleTrackerRequest } = await import('../src/tracker.js');
  const hash = Buffer.alloc(20, 0x5a);
  const peerIdA = Buffer.alloc(20, 0x41);
  const peerIdB = Buffer.alloc(20, 0x42);
  const hexQuery = buffer => [...buffer].map(byte => '%' + byte.toString(16).padStart(2, '0')).join('');
  const announce = (peerId, ip) => {
    const req = {
      method: 'GET',
      url: '/announce?info_hash=' + hexQuery(hash) + '&peer_id=' + hexQuery(peerId) + '&port=6881&uploaded=0&downloaded=0&left=100&event=started&numwant=50',
      socket: { remoteAddress: ip }
    };
    const res = {
      statusCode: 0, headers: {}, body: null,
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end(body) { this.body = body; }
    };
    assert.equal(handleTrackerRequest(req, res), true);
    return res;
  };
  const first = announce(peerIdA, '127.0.0.1');
  const second = announce(peerIdB, '127.0.0.2');
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.ok(Buffer.isBuffer(second.body));
  assert.ok(second.body.includes(Buffer.from([127, 0, 0, 1, 0x1a, 0xe1])));
});
