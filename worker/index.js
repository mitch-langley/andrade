const COOKIE = 'acceso';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 días
const encoder = new TextEncoder();

function privateResponse(response, extraHeaders) {
  const headers = new Headers(response.headers);
  if (extraHeaders) extraHeaders.forEach((value, key) => headers.append(key, value));
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('CDN-Cache-Control', 'no-store');
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.append('Vary', 'Cookie');
  return new Response(response.body, { status: response.status, headers });
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function toBase64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Compara las contraseñas vía HMAC para que el tiempo no dependa de su contenido.
async function passwordMatches(candidate, password) {
  const [a, b] = await Promise.all([hmac('password-check', candidate), hmac('password-check', password)]);
  return sameBytes(a, b);
}

async function createToken(password, now = Date.now()) {
  const expires = Math.floor(now / 1000) + MAX_AGE;
  return `${expires}.${toBase64url(await hmac(password, `gallery:${expires}`))}`;
}

async function validToken(token, password, now = Date.now()) {
  const [expires, signature] = (token || '').split('.');
  if (!/^\d+$/.test(expires || '') || Number(expires) < now / 1000) return false;
  const expected = toBase64url(await hmac(password, `gallery:${expires}`));
  return sameBytes(encoder.encode(signature || ''), encoder.encode(expected));
}

function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const password = env.GALLERY_PASSWORD;
    if (!password) return privateResponse(new Response('Acceso no configurado', { status: 503 }));

    if (pathname === '/api/login') {
      if (request.method !== 'POST') {
        return privateResponse(new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } }));
      }
      let candidate = '';
      try { candidate = String((await request.json()).password ?? ''); } catch { /* cuerpo inválido */ }
      if (!candidate || !(await passwordMatches(candidate, password))) {
        return privateResponse(new Response('Contraseña incorrecta', { status: 401 }));
      }
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      const cookie = `${COOKIE}=${await createToken(password)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Strict${secure}`;
      return privateResponse(new Response(null, { status: 204, headers: { 'Set-Cookie': cookie } }));
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return privateResponse(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }));
    }

    // La página es pública: solo muestra el cuadro de contraseña hasta que el acceso se verifica.
    if (pathname === '/' || pathname === '/index.html') {
      url.pathname = '/index.html';
      return privateResponse(await env.ASSETS.fetch(new Request(url, request)));
    }

    const photoRequest = /^\/assets\/[^/]+\.webp$/.test(pathname);
    if (!photoRequest && pathname !== '/api/session') {
      return privateResponse(new Response('Not found', { status: 404 }));
    }
    if (!(await validToken(readCookie(request, COOKIE), password))) {
      return privateResponse(new Response('Authentication required', { status: 401 }));
    }
    if (pathname === '/api/session') return privateResponse(new Response(null, { status: 204 }));
    return privateResponse(await env.ASSETS.fetch(request));
  },
};
