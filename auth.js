import { loadClerk } from './clerk-client.js';

const gallery = document.getElementById('gallery-content');
const status = document.getElementById('account-status');
const retry = document.getElementById('auth-retry');
const userButton = document.getElementById('user-button');
let visibleSession;
let mounted = false;
let sessionCheck = 0;

function hideGallery() {
  gallery.hidden = true;
  gallery.querySelectorAll('img[data-src]').forEach(image => image.removeAttribute('src'));
  visibleSession = undefined;
}

retry.addEventListener('click', () => window.location.reload());
try {
  const clerk = await loadClerk();
  async function renderAccount() {
    const check = ++sessionCheck;
    if (!clerk.isSignedIn) {
      hideGallery();
      window.location.replace('/sign-in');
      return;
    }
    if (visibleSession === clerk.session.id) return;
    hideGallery();
    try {
      const token = await clerk.session.getToken();
      const response = await fetch('/api/session', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (check !== sessionCheck) return;
      if (response.status !== 204) throw new Error('Session verification failed.');
      visibleSession = clerk.session.id;
      if (!mounted) {
        clerk.mountUserButton(userButton);
        mounted = true;
      }
      userButton.hidden = false;
      status.hidden = true;
      gallery.hidden = false;
      gallery.querySelectorAll('img[data-src]').forEach(image => { image.src = image.dataset.src; });
      window.dispatchEvent(new Event('resize'));
    } catch {
      if (check !== sessionCheck) return;
      hideGallery();
      status.hidden = false;
      status.textContent = 'No se pudo verificar el acceso. Vuelve a intentarlo.';
      retry.hidden = false;
    }
  }
  clerk.addListener(renderAccount);
  await renderAccount();
  window.addEventListener('pageshow', event => {
    if (event.persisted) { hideGallery(); void renderAccount(); }
  });
} catch {
  hideGallery();
  status.textContent = 'No se pudo cargar el acceso. Abre la galería desde el servidor protegido.';
  retry.hidden = false;
}
