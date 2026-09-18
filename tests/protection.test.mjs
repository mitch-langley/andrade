import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import worker, { createHandler } from '../worker/index.js';
import { readFile, readdir } from 'node:fs/promises';

function environment(extra = {}) {
  const fetched = [];
  return {
    fetched,
    CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('auth.test$').toString('base64url')}`,
    ALLOWED_ORIGINS: 'http://localhost:8787',
    ASSETS: { fetch: async request => {
      fetched.push(new URL(request.url).pathname);
      return new Response(request.method === 'HEAD' ? null : 'PRIVATE ASSET', { headers: { 'Cache-Control': 'public, max-age=31536000' } });
    } },
    ...extra,
  };
}
const request = (path, options) => new Request(`http://localhost:8787${path}`, options);
const signedOut = () => ({ status: 'signed-out', isAuthenticated: false, headers: new Headers() });
const signedIn = () => ({ status: 'signed-in', isAuthenticated: true, headers: new Headers(), toAuth: () => ({ userId: 'user_test' }) });

test('signed-out gallery redirects and photo requests never reach assets', async () => {
  const env = environment();
  const fetch = createHandler(signedOut);
  for (const path of ['/', '/index.html']) {
    const response = await fetch(request(path), env);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), '/sign-in');
  }
  for (const path of ['/assets/lucy_1a.webp', '/assets/lucy_1a.webp?download=1', '/api/session']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(request(path, { method, headers: { Range: 'bytes=0-100' } }), env);
      assert.equal(response.status, 401);
      assert.match(response.headers.get('Cache-Control'), /no-store/);
    }
  }
  assert.deepEqual(env.fetched, []);
});

test('valid sessions may view photos; downstream public cache headers are overridden', async () => {
  const env = environment();
  const fetch = createHandler(signedIn);
  const response = await fetch(request('/assets/lucy_1a.webp'), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'PRIVATE ASSET');
  assert.match(response.headers.get('Cache-Control'), /private, no-store/);
  assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
  assert.equal((await fetch(request('/api/session'), env)).status, 204);
  assert.deepEqual(env.fetched, ['/assets/lucy_1a.webp']);
});

test('login shell is public, while source, secrets and alternate paths are unavailable', async () => {
  const env = environment();
  const fetch = createHandler(signedOut);
  assert.equal((await fetch(request('/sign-in'), env)).status, 200);
  assert.deepEqual(env.fetched, ['/sign-in.html']);
  for (const path of ['/.env.local', '/.git/config', '/worker/index.js', '/dist/assets/lucy_1a.webp', '/assets/%2e%2e%2findex.html']) {
    assert.equal((await fetch(request(path), env)).status, 404);
  }
  assert.deepEqual(env.fetched, ['/sign-in.html']);
});

test('authentication errors and pending sessions fail closed', async () => {
  const env = environment();
  const failed = createHandler(() => { throw new Error('Unavailable'); });
  assert.equal((await failed(request('/assets/lucy_1a.webp'), env)).status, 503);
  const pending = createHandler(() => ({ ...signedIn(), isAuthenticated: false }));
  assert.equal((await pending(request('/assets/lucy_1a.webp'), env)).status, 401);
  assert.equal((await worker.fetch(request('/assets/lucy_1a.webp'), env)).status, 503);
  assert.deepEqual(env.fetched, []);
});

test('Clerk handshake preserves redirects and cookies without serving photos', async () => {
  const env = environment();
  const fetch = createHandler(() => ({ status: 'handshake', headers: new Headers({ Location: 'https://auth.test/handshake', 'Set-Cookie': 'handshake=test; HttpOnly' }) }));
  const response = await fetch(request('/assets/lucy_1a.webp'), env);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('Location'), 'https://auth.test/handshake');
  assert.match(response.headers.get('Set-Cookie'), /handshake=test/);
  assert.deepEqual(env.fetched, []);
});

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function sessionToken(overrides = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
  const payload = encode({ iss: 'https://auth.test', sub: 'user_test', sid: 'sess_test', azp: 'http://localhost:8787', iat: now, nbf: now - 5, exp: now + 60, v: 2, sts: 'active', ...overrides });
  const message = `${header}.${payload}`;
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), key).toString('base64url')}`;
}
test('real Clerk verification accepts signed tokens and rejects expired, forged and wrong-origin tokens', async () => {
  const env = environment({ CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }) });
  const verify = token => worker.fetch(request('/assets/lucy_1a.webp', { headers: { Authorization: `Bearer ${token}` } }), env);
  assert.equal((await verify(sessionToken())).status, 200);
  env.fetched.length = 0;
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const token of [sessionToken({ exp: 1 }), sessionToken({ azp: 'https://untrusted.example' }), sessionToken({}, wrongKey), 'forged-token']) {
    assert.equal((await verify(token)).status, 401);
  }
  assert.deepEqual(env.fetched, []);
});

test('build contains only intended web files and photos', async () => {
  const files = await readdir(new URL('../dist/', import.meta.url));
  assert.deepEqual(files.sort(), ['assets', 'auth.js', 'clerk-client.js', 'index.html', 'sign-in.html', 'sign-in.js']);
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="gallery-content" hidden/);
  assert.doesNotMatch(html, /\ssrc="assets\//);
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.assets.run_worker_first, true);
});
