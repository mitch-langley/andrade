import { createClerkClient } from '@clerk/backend';

const publicScripts = new Set(['/auth.js', '/clerk-client.js', '/sign-in.js']);
const loginPaths = new Set(['/sign-in', '/sign-up', '/sign-in.html']);

function privateResponse(response, authHeaders) {
  const headers = new Headers(response.headers);
  if (authHeaders) authHeaders.forEach((value, key) => headers.append(key, value));
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('CDN-Cache-Control', 'no-store');
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.append('Vary', 'Cookie, Authorization');
  return new Response(response.body, { status: response.status, headers });
}

async function authenticate(request, env) {
  const authorizedParties = (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  if ((!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) || !env.CLERK_PUBLISHABLE_KEY || !authorizedParties.length) {
    throw new Error('Missing authentication configuration.');
  }
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
  return clerk.authenticateRequest(request, { authorizedParties, acceptsToken: 'session_token', jwtKey: env.CLERK_JWT_KEY });
}

// Inject authentication in tests; production always uses Clerk's session verification.
export function createHandler(verifySession = authenticate) {
  return async function fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method)) {
      return privateResponse(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }));
    }
    if (pathname === '/auth-config') {
      if (!env.CLERK_PUBLISHABLE_KEY) return privateResponse(new Response('Authentication unavailable', { status: 503 }));
      return privateResponse(Response.json({ publishableKey: env.CLERK_PUBLISHABLE_KEY }));
    }
    if (loginPaths.has(pathname)) {
      url.pathname = '/sign-in.html';
      return privateResponse(await env.ASSETS.fetch(new Request(url, request)));
    }
    if (publicScripts.has(pathname)) return privateResponse(await env.ASSETS.fetch(request));

    const galleryRequest = pathname === '/' || pathname === '/index.html';
    const photoRequest = /^\/assets\/[^/]+\.webp$/.test(pathname);
    if (!galleryRequest && !photoRequest && pathname !== '/api/session') {
      return privateResponse(new Response('Not found', { status: 404 }));
    }
    let session;
    try {
      session = await verifySession(request, env);
    } catch {
      return privateResponse(new Response('Authentication temporarily unavailable', { status: 503 }));
    }
    if (session.status === 'handshake') {
      const response = session.headers.get('location')
        ? new Response(null, { status: 307 })
        : new Response('Authentication required', { status: 401 });
      return privateResponse(response, session.headers);
    }
    if (!session.isAuthenticated || session.status !== 'signed-in' || !session.toAuth()?.userId) {
      const response = galleryRequest
        ? new Response(null, { status: 302, headers: { Location: '/sign-in' } })
        : new Response('Authentication required', { status: 401 });
      return privateResponse(response, session.headers);
    }
    if (pathname === '/api/session') return privateResponse(new Response(null, { status: 204 }), session.headers);
    if (galleryRequest) url.pathname = '/index.html';
    return privateResponse(await env.ASSETS.fetch(new Request(url, request)), session.headers);
  };
}

export default { fetch: createHandler() };
