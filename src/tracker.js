import net from 'node:net';

const ANNOUNCE_INTERVAL = 1800;
const PEER_TTL = 35 * 60 * 1000;
const MAX_PEERS_PER_SWARM = 5000;
const MAX_SWARMS = 5000;
const RATE_WINDOW = 60_000;
const RATE_LIMIT = 120;

const swarms = new Map();
const rate = new Map();

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(String(value.length) + ':'), value]);
  if (typeof value === 'string') return bencode(Buffer.from(value));
  if (typeof value === 'number' && Number.isSafeInteger(value)) return Buffer.from('i' + value + 'e');
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, item]) => [Buffer.isBuffer(key) ? key : Buffer.from(String(key)), item]).sort(([a], [b]) => Buffer.compare(a, b));
    return Buffer.concat([Buffer.from('d'), ...entries.flatMap(([key, item]) => [bencode(key), bencode(item)]), Buffer.from('e')]);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return Buffer.concat([Buffer.from('d'), ...entries.flatMap(([key, item]) => [bencode(key), bencode(item)]), Buffer.from('e')]);
  }
  throw new TypeError('Tipo bencode não suportado');
}

function parseRawQuery(rawUrl) {
  const query = rawUrl.split('?', 2)[1] || '';
  const out = new Map();
  for (const part of query.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const key = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
    const raw = i < 0 ? '' : part.slice(i + 1);
    const bytes = [];
    for (let p = 0; p < raw.length;) {
      if (raw[p] === '%' && /^[0-9a-f]{2}$/i.test(raw.slice(p + 1, p + 3))) {
        bytes.push(parseInt(raw.slice(p + 1, p + 3), 16));
        p += 3;
      } else {
        const code = raw.codePointAt(p);
        bytes.push(...Buffer.from(String.fromCodePoint(code)));
        p += code > 0xffff ? 2 : 1;
      }
    }
    if (!out.has(key)) out.set(key, Buffer.from(bytes));
  }
  return out;
}

function textParam(params, key, fallback = '') {
  return params.has(key) ? params.get(key).toString('utf8') : fallback;
}

function intParam(params, key, fallback = 0) {
  const raw = textParam(params, key, String(fallback));
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}

function cleanIp(ip) {
  if (typeof ip !== 'string') return null;
  if (ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) return ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

function compactPeers(peers, family) {
  const selected = peers.filter(peer => net.isIP(peer.ip) === family);
  return Buffer.concat(selected.map(peer => {
    if (family === 4) {
      return Buffer.concat([Buffer.from(peer.ip.split('.').map(Number)), Buffer.from([peer.port >> 8, peer.port & 255])]);
    }
    const words = peer.ip.split(':');
    const expanded = [];
    const gap = words.indexOf('');
    let normalized = words;
    if (gap !== -1) {
      const left = words.slice(0, gap).filter(Boolean);
      const right = words.slice(gap + 1).filter(Boolean);
      normalized = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    }
    for (const word of normalized) expanded.push(parseInt(word || '0', 16));
    const ipBytes = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) ipBytes.writeUInt16BE(expanded[i] || 0, i * 2);
    return Buffer.concat([ipBytes, Buffer.from([peer.port >> 8, peer.port & 255])]);
  }));
}

function getSwarm(hash) {
  let swarm = swarms.get(hash);
  if (!swarm) {
    if (swarms.size >= MAX_SWARMS) {
      const first = swarms.keys().next().value;
      if (first !== undefined) swarms.delete(first);
    }
    swarm = { peers: new Map(), completed: 0 };
    swarms.set(hash, swarm);
  }
  return swarm;
}

function prune(swarm, now) {
  for (const [id, peer] of swarm.peers) {
    if (now - peer.seen > PEER_TTL) swarm.peers.delete(id);
  }
}

function limited(ip, now) {
  const old = rate.get(ip);
  if (!old || now - old.start >= RATE_WINDOW) {
    rate.set(ip, { start: now, count: 1 });
    if (rate.size > 10_000) {
      for (const [key, value] of rate) if (now - value.start >= RATE_WINDOW) rate.delete(key);
    }
    return false;
  }
  old.count++;
  return old.count > RATE_LIMIT;
}

function sendBencoded(res, status, value) {
  const body = bencode(value);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=ISO-8859-1',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

export function handleTrackerRequest(req, res) {
  const pathname = (req.url || '').split('?', 1)[0];
  if (pathname !== '/announce' && pathname !== '/scrape') return false;
  if (req.method !== 'GET') {
    res.setHeader?.('Allow', 'GET');
    sendBencoded(res, 405, { 'failure reason': 'Use GET for BitTorrent tracker requests' });
    return true;
  }

  const params = parseRawQuery(req.url || '');
  const now = Date.now();
  const ip = cleanIp(req.socket?.remoteAddress) || 'unknown';

  if (limited(ip, now)) {
    sendBencoded(res, 429, { 'failure reason': 'Rate limit exceeded; retry later' });
    return true;
  }

  if (pathname === '/scrape') {
    const hashes = params.has('info_hash') ? [params.get('info_hash')] : [];
    if (!hashes.length || hashes.some(hash => hash.length !== 20)) {
      sendBencoded(res, 400, { 'failure reason': 'scrape requires a 20-byte info_hash' });
      return true;
    }
    const files = new Map();
    for (const hash of hashes) {
      const key = hash.toString('hex');
      const swarm = swarms.get(key);
      if (swarm) prune(swarm, now);
      const peers = swarm ? [...swarm.peers.values()] : [];
      files.set(hash, {
        complete: peers.filter(peer => peer.left === 0).length,
        downloaded: swarm?.completed || 0,
        incomplete: peers.filter(peer => peer.left > 0).length
      });
    }
    sendBencoded(res, 200, { files });
    return true;
  }

  const hash = params.get('info_hash');
  const peerId = params.get('peer_id');
  const port = intParam(params, 'port', -1);
  if (!hash || hash.length !== 20 || !peerId || peerId.length !== 20 || port < 1 || port > 65535) {
    sendBencoded(res, 400, { 'failure reason': 'Missing or invalid info_hash, peer_id or port' });
    return true;
  }

  const uploaded = intParam(params, 'uploaded');
  const downloaded = intParam(params, 'downloaded');
  const left = intParam(params, 'left', -1);
  if (left < 0) {
    sendBencoded(res, 400, { 'failure reason': 'Missing or invalid left parameter' });
    return true;
  }

  const hashKey = hash.toString('hex');
  const peerKey = peerId.toString('hex');
  const swarm = getSwarm(hashKey);
  prune(swarm, now);
  const event = textParam(params, 'event');
  if (event === 'stopped') {
    swarm.peers.delete(peerKey);
  } else {
    const peerIp = ip;
    if (net.isIP(peerIp)) {
      swarm.peers.set(peerKey, { id: peerKey, ip: peerIp, port, uploaded, downloaded, left, seen: now });
      if (swarm.peers.size > MAX_PEERS_PER_SWARM) {
        const oldest = [...swarm.peers.values()].sort((a, b) => a.seen - b.seen).slice(0, swarm.peers.size - MAX_PEERS_PER_SWARM);
        for (const peer of oldest) swarm.peers.delete(peer.id);
      }
    }
    if (event === 'completed') swarm.completed++;
  }

  const requesterWant = Math.max(0, Math.min(100, intParam(params, 'numwant', 50)));
  const peers = [...swarm.peers.values()]
    .filter(peer => peer.id !== peerKey && peer.seen + PEER_TTL > now)
    .sort(() => Math.random() - 0.5)
    .slice(0, requesterWant);
  const response = {
    interval: ANNOUNCE_INTERVAL,
    'min interval': 300,
    complete: [...swarm.peers.values()].filter(peer => peer.left === 0).length,
    incomplete: [...swarm.peers.values()].filter(peer => peer.left > 0).length,
    peers: compactPeers(peers, 4),
    peers6: compactPeers(peers, 6)
  };
  sendBencoded(res, 200, response);
  return true;
}

export function trackerStats() {
  let peers = 0;
  for (const swarm of swarms.values()) peers += swarm.peers.size;
  return { swarms: swarms.size, peers };
}

export const trackerConstants = Object.freeze({
  announceInterval: ANNOUNCE_INTERVAL,
  peerTtlMs: PEER_TTL,
  maxPeersPerSwarm: MAX_PEERS_PER_SWARM
});

export const trackerInternals = Object.freeze({ bencode, parseRawQuery });
