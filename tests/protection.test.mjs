import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { readFile, readdir } from 'node:fs/promises';

function environment(extra = {}) {
  const fetched = [];
  return {
    fetched,
    GALLERY_PASSWORD: 'secreto',
    ASSETS: { fetch: async request => {
      fetched.push(new URL(request.url).pathname);
      return new Response(request.method === 'HEAD' ? null : 'PRIVATE ASSET', { headers: { 'Cache-Control': 'public, max-age=31536000' } });
    } },
    ...extra,
  };
}
const request = (path, options) => new Request(`https://example.test${path}`, options);
const login = (env, password) => worker.fetch(request('/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
}), env);
async function sessionCookie(env) {
  const response = await login(env, 'secreto');
  assert.equal(response.status, 204);
  return response.headers.get('Set-Cookie').split(';')[0];
}

test('page is public but photos and session require the password', async () => {
  const env = environment();
  assert.equal((await worker.fetch(request('/'), env)).status, 200);
  assert.deepEqual(env.fetched, ['/index.html']);
  env.fetched.length = 0;
  for (const path of ['/assets/lucy_1a.webp', '/assets/lucy_1a.webp?download=1', '/api/session']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(request(path, { method, headers: { Range: 'bytes=0-100' } }), env);
      assert.equal(response.status, 401);
      assert.match(response.headers.get('Cache-Control'), /no-store/);
    }
  }
  assert.deepEqual(env.fetched, []);
});

test('wrong, empty or malformed passwords are rejected without a cookie', async () => {
  const env = environment();
  for (const password of ['incorrecta', '', 'secret', 'secreto ']) {
    const response = await login(env, password);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
  const malformed = await worker.fetch(request('/api/login', { method: 'POST', body: 'no-json' }), env);
  assert.equal(malformed.status, 401);
  assert.equal((await worker.fetch(request('/api/login'), env)).status, 405);
});

test('correct password sets a secure cookie that unlocks photos with private caching', async () => {
  const env = environment();
  const response = await login(env, 'secreto');
  assert.match(response.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict; Secure/);
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await worker.fetch(request('/api/session', { headers: { Cookie: cookie } }), env)).status, 204);
  const photo = await worker.fetch(request('/assets/lucy_1a.webp', { headers: { Cookie: cookie } }), env);
  assert.equal(photo.status, 200);
  assert.equal(await photo.text(), 'PRIVATE ASSET');
  assert.match(photo.headers.get('Cache-Control'), /private, no-store/);
  assert.equal(photo.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
});

test('forged, expired and old-password cookies are rejected', async () => {
  const env = environment();
  const cookie = await sessionCookie(env);
  const [, value] = cookie.split('=');
  const [expires, signature] = value.split('.');
  const forged = [
    `acceso=${Number(expires) + 1}.${signature}`,
    `acceso=1.${signature}`,
    `acceso=${expires}.AAAA`,
    'acceso=garbage',
  ];
  for (const bad of forged) {
    assert.equal((await worker.fetch(request('/assets/lucy_1a.webp', { headers: { Cookie: bad } }), env)).status, 401);
  }
  const changed = environment({ GALLERY_PASSWORD: 'nueva' });
  assert.equal((await worker.fetch(request('/api/session', { headers: { Cookie: cookie } }), changed)).status, 401);
  assert.deepEqual(env.fetched, []);
});

test('source, secrets and alternate paths are unavailable; missing password fails closed', async () => {
  const env = environment();
  const cookie = await sessionCookie(env);
  for (const path of ['/.env.local', '/.dev.vars', '/.git/config', '/worker/index.js', '/dist/assets/lucy_1a.webp', '/assets/%2e%2e%2findex.html']) {
    assert.equal((await worker.fetch(request(path, { headers: { Cookie: cookie } }), env)).status, 404);
  }
  const unconfigured = environment({ GALLERY_PASSWORD: undefined });
  assert.equal((await worker.fetch(request('/assets/lucy_1a.webp'), unconfigured)).status, 503);
  assert.equal((await login(unconfigured, 'undefined')).status, 503);
  assert.deepEqual(env.fetched, []);
});

test('build contains only the page and photos', async () => {
  const files = await readdir(new URL('../dist/', import.meta.url));
  assert.deepEqual(files.sort(), ['assets', 'index.html']);
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="gallery-content" hidden/);
  assert.doesNotMatch(html, /\ssrc="assets\//);
  assert.doesNotMatch(html, /clerk/i);
});
