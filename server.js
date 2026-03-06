const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
let PgPool = null;
try {
  PgPool = require('pg').Pool;
} catch (_err) {
  // Optional: fallback to file storage if pg is unavailable.
}

const PORT = Number(process.env.PORT || 3000);
const DATA_PATH = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATABASE_URL = process.env.DATABASE_URL || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const SELF_PING_URL = (process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const SELF_PING_ENABLED = String(process.env.SELF_PING_ENABLED || 'true').toLowerCase() === 'true';
const SELF_PING_INTERVAL_MS = 10 * 60 * 1000;

const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || 8);
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 72);

const TILE_COUNT = 2048;
const TILE_SIZE = 1000;
const ZOOM_LEVEL = 11;
const MAX_NAME_LENGTH = 24;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function createDefaultState() {
  return {
    users: {},
    sessions: {},
    pixels: {},
    lastPlacementByUser: {}
  };
}

function sanitizeState(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return createDefaultState();
  }
  return {
    users: parsed.users || {},
    sessions: parsed.sessions || {},
    pixels: parsed.pixels || {},
    lastPlacementByUser: parsed.lastPlacementByUser || {}
  };
}

function loadStateFromFile() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    return sanitizeState(JSON.parse(raw));
  } catch (_err) {
    return createDefaultState();
  }
}

const state = createDefaultState();
Object.assign(state, loadStateFromFile());

let dbPool = null;
let usingPostgres = false;
let saveTimer = null;
const sseClients = new Set();

function persistStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (usingPostgres && dbPool) {
      try {
        await dbPool.query(
          `INSERT INTO app_state (id, data, updated_at)
           VALUES (1, $1::jsonb, NOW())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [JSON.stringify(state)]
        );
      } catch (err) {
        console.error('Failed to save state to postgres:', err.message);
      }
      return;
    }

    fs.writeFile(DATA_PATH, JSON.stringify(state), (err) => {
      if (err) {
        console.error('Failed to save data.json:', err.message);
      }
    });
  }, 150);
}

async function initStorage() {
  if (!DATABASE_URL || !PgPool) {
    console.log('Storage mode: file (data.json)');
    return;
  }

  try {
    dbPool = new PgPool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : undefined
    });

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id SMALLINT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const result = await dbPool.query('SELECT data FROM app_state WHERE id = 1');
    if (result.rows.length > 0 && result.rows[0].data) {
      Object.assign(state, sanitizeState(result.rows[0].data));
      console.log('Loaded state from postgres.');
    } else {
      await dbPool.query(
        `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(state)]
      );
      console.log('Initialized postgres state from current memory state.');
    }

    usingPostgres = true;
    console.log('Storage mode: postgres');
  } catch (err) {
    console.error('Postgres init failed, falling back to file storage:', err.message);
    usingPostgres = false;
    if (dbPool) {
      try {
        await dbPool.end();
      } catch (_ignore) {
        // no-op
      }
      dbPool = null;
    }
    console.log('Storage mode: file (data.json)');
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  });
  res.end();
}

function normalizeName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

function getAuthToken(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const token of Object.keys(state.sessions)) {
    if (state.sessions[token].expiresAt < now) {
      delete state.sessions[token];
    }
  }
}

function getSession(req) {
  cleanupExpiredSessions();
  const token = getAuthToken(req);
  if (!token) return null;
  const session = state.sessions[token];
  if (!session) return null;
  const user = state.users[session.userId];
  if (!user) return null;
  return {
    token,
    userId: user.userId,
    name: user.name,
    expiresAt: session.expiresAt
  };
}

function createSession(name) {
  const userId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_HOURS * 60 * 60 * 1000;
  state.users[userId] = { userId, name, createdAt: now };
  state.sessions[token] = { token, userId, createdAt: now, expiresAt };
  persistStateSoon();
  return { token, userId, name, expiresAt };
}

function isUsernameTaken(name) {
  const target = String(name || '').toLowerCase();
  return Object.values(state.users).some((user) => String(user.name || '').toLowerCase() === target);
}

function isValidTileCoord(value) {
  return Number.isInteger(value) && value >= 0 && value < TILE_COUNT;
}

function isValidPixelCoord(value) {
  return Number.isInteger(value) && value >= 0 && value < TILE_SIZE;
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function pixelKey(tileX, tileY, x, y) {
  return `${tileX}:${tileY}:${x}:${y}`;
}

function broadcastEvent(eventName, payload) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(frame);
  }
}

function tileBoundsFromQuery(urlObj) {
  const tileMinX = Number.parseInt(urlObj.searchParams.get('tileMinX') || '', 10);
  const tileMaxX = Number.parseInt(urlObj.searchParams.get('tileMaxX') || '', 10);
  const tileMinY = Number.parseInt(urlObj.searchParams.get('tileMinY') || '', 10);
  const tileMaxY = Number.parseInt(urlObj.searchParams.get('tileMaxY') || '', 10);

  if (![tileMinX, tileMaxX, tileMinY, tileMaxY].every(Number.isInteger)) {
    return null;
  }
  if (!isValidTileCoord(tileMinX) || !isValidTileCoord(tileMaxX) || !isValidTileCoord(tileMinY) || !isValidTileCoord(tileMaxY)) {
    return null;
  }
  if (tileMinX > tileMaxX || tileMinY > tileMaxY) {
    return null;
  }
  if (tileMaxX - tileMinX > 32 || tileMaxY - tileMinY > 32) {
    return null;
  }

  return { tileMinX, tileMaxX, tileMinY, tileMaxY };
}

function listPixelsInBounds(bounds) {
  const out = [];
  for (const value of Object.values(state.pixels)) {
    if (
      value.tileX >= bounds.tileMinX &&
      value.tileX <= bounds.tileMaxX &&
      value.tileY >= bounds.tileMinY &&
      value.tileY <= bounds.tileMaxY
    ) {
      out.push(value);
    }
  }
  return out;
}

function serveStaticFile(reqPath, res) {
  const clean = reqPath === '/' ? '/index.html' : reqPath;
  const fullPath = path.join(PUBLIC_DIR, clean);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': CORS_ORIGIN
  });

  res.write('event: hello\ndata: {"ok":true}\n\n');
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
}

async function routeApi(req, res, urlObj) {
  if (req.method === 'GET' && urlObj.pathname === '/api/config') {
    sendJson(res, 200, {
      cooldownSeconds: COOLDOWN_SECONDS,
      tileCount: TILE_COUNT,
      tileSize: TILE_SIZE,
      zoomLevel: ZOOM_LEVEL,
      totalPlacedPixels: Object.keys(state.pixels).length
    });
    return true;
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/session') {
    const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const name = normalizeName(body.name);
    if (!name || name.length < 2) {
      sendJson(res, 400, { error: 'Name must be at least 2 characters.' });
      return true;
    }
    if (isUsernameTaken(name)) {
      sendJson(res, 409, { error: 'Username already taken.' });
      return true;
    }
    sendJson(res, 201, createSession(name));
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/pixel-info') {
    const tileX = Number.parseInt(urlObj.searchParams.get('tileX') || '', 10);
    const tileY = Number.parseInt(urlObj.searchParams.get('tileY') || '', 10);
    const x = Number.parseInt(urlObj.searchParams.get('x') || '', 10);
    const y = Number.parseInt(urlObj.searchParams.get('y') || '', 10);
    if (!isValidTileCoord(tileX) || !isValidTileCoord(tileY) || !isValidPixelCoord(x) || !isValidPixelCoord(y)) {
      sendJson(res, 400, { error: 'Invalid tile/pixel coordinates.' });
      return true;
    }
    const key = pixelKey(tileX, tileY, x, y);
    const pixel = state.pixels[key];
    if (!pixel) {
      sendJson(res, 404, { error: 'Pixel not painted yet.' });
      return true;
    }
    sendJson(res, 200, { pixel });
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/me') {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    sendJson(res, 200, session);
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/pixels') {
    const bounds = tileBoundsFromQuery(urlObj);
    if (!bounds) {
      sendJson(res, 400, { error: 'Invalid tile bounds.' });
      return true;
    }
    sendJson(res, 200, { pixels: listPixelsInBounds(bounds) });
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/stream') {
    handleSse(req, res);
    return true;
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/place') {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }

    const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }

    const tileX = Number.parseInt(body.tileX, 10);
    const tileY = Number.parseInt(body.tileY, 10);
    const x = Number.parseInt(body.x, 10);
    const y = Number.parseInt(body.y, 10);
    const color = String(body.color || '').toLowerCase();

    if (!isValidTileCoord(tileX) || !isValidTileCoord(tileY) || !isValidPixelCoord(x) || !isValidPixelCoord(y)) {
      sendJson(res, 400, { error: 'Invalid tile/pixel coordinates.' });
      return true;
    }
    if (!isHexColor(color)) {
      sendJson(res, 400, { error: 'Color must be #RRGGBB.' });
      return true;
    }

    const now = Date.now();
    const lastAt = state.lastPlacementByUser[session.userId] || 0;
    const nextPlacementAt = lastAt + COOLDOWN_SECONDS * 1000;
    if (now < nextPlacementAt) {
      sendJson(res, 429, { error: 'Cooldown active', nextPlacementAt });
      return true;
    }

    const key = pixelKey(tileX, tileY, x, y);
    const exists = Boolean(state.pixels[key]);
    const pixel = {
      id: key,
      tileX,
      tileY,
      x,
      y,
      color,
      ownerId: session.userId,
      ownerName: session.name,
      updatedAt: now
    };

    state.pixels[key] = pixel;
    state.lastPlacementByUser[session.userId] = now;
    persistStateSoon();

    if (!exists) {
      broadcastEvent('count', { totalPlacedPixels: Object.keys(state.pixels).length });
    }
    broadcastEvent('pixel', pixel);

    sendJson(res, 201, {
      ok: true,
      pixel,
      nextPlacementAt: now + COOLDOWN_SECONDS * 1000
    });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (urlObj.pathname === '/healthz') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    if (urlObj.pathname.startsWith('/api/') && req.method === 'OPTIONS') {
      sendNoContent(res);
      return;
    }
    if (urlObj.pathname.startsWith('/api/')) {
      const handled = await routeApi(req, res, urlObj);
      if (!handled) sendJson(res, 404, { error: 'Not found' });
      return;
    }
    serveStaticFile(urlObj.pathname, res);
  } catch (err) {
    sendJson(res, 500, { error: 'Internal error', details: err.message });
  }
});

async function start() {
  await initStorage();

  server.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);
    console.log('Run command: node server.js');
    if (SELF_PING_ENABLED && SELF_PING_URL) {
      const target = `${SELF_PING_URL}/healthz`;
      setInterval(async () => {
        try {
          const response = await fetch(target, { method: 'GET' });
          if (!response.ok) {
            console.warn(`Self ping failed: ${response.status} ${response.statusText}`);
          }
        } catch (err) {
          console.warn(`Self ping error: ${err.message}`);
        }
      }, SELF_PING_INTERVAL_MS).unref();
      console.log(`Self ping enabled every 10m -> ${target}`);
    }
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
