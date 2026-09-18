let clerkPromise;

function loadScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.crossOrigin = 'anonymous';
    script.async = true;
    if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Unable to load authentication.'));
    document.head.appendChild(script);
  });
}

export function loadClerk() {
  clerkPromise ??= (async () => {
    const response = await fetch('/auth-config', { cache: 'no-store' });
    if (!response.ok) throw new Error('Protected server is unavailable.');
    const { publishableKey } = await response.json();
    const domain = atob(publishableKey.split('_')[2]).replace(/\$$/, '');
    await Promise.all([
      loadScript(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`),
      loadScript(`https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, publishableKey),
    ]);
    await window.Clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      signInUrl: '/sign-in', signUpUrl: '/sign-up',
      signInFallbackRedirectUrl: '/', signUpFallbackRedirectUrl: '/', afterSignOutUrl: '/sign-in',
      appearance: { variables: { colorPrimary: '#222222', fontFamily: 'Arial, Helvetica, sans-serif', borderRadius: '8px' } },
    });
    return window.Clerk;
  })();
  return clerkPromise;
}
