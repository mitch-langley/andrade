import { loadClerk } from './clerk-client.js';

const status = document.getElementById('auth-status');
const retry = document.getElementById('retry');
retry.addEventListener('click', () => window.location.reload());

try {
  const clerk = await loadClerk();
  function checkSession() {
    if (clerk.isSignedIn) window.location.replace('/');
  }
  if (!clerk.isSignedIn) {
    const form = document.getElementById('sign-in-form');
    const options = { routing: 'hash', signInUrl: '/sign-in', signUpUrl: '/sign-up', forceRedirectUrl: '/' };
    if (window.location.pathname === '/sign-up') clerk.mountSignUp(form, options);
    else clerk.mountSignIn(form, options);
  }
  status.hidden = true;
  clerk.addListener(checkSession);
  checkSession();
} catch {
  status.textContent = 'No se pudo cargar el acceso. Revisa tu conexión e inténtalo de nuevo.';
  retry.hidden = false;
}
