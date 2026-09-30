// Session connectée : génère une clé API depuis https://sourcelibrary.org/developers.
export const DEVELOPERS_URL = 'https://sourcelibrary.org/developers';

// Le site plante ("s.identify is not a function") quand window.posthog n'est
// qu'un stub non initialisé : on ajoute des méthodes no-op avant ses scripts.
export async function patchPosthogStub(context) {
  await context.addInitScript(() => {
    let ph;
    const patch = o => {
      if (o) for (const m of ['identify', 'reset', 'capture', 'register', 'setPersonProperties'])
        if (typeof o[m] !== 'function') { try { o[m] = () => {}; } catch {} }
      return o;
    };
    Object.defineProperty(window, 'posthog', { configurable: true, get: () => patch(ph), set: v => { ph = v; } });
  });
}

// Ouvre le lien magique reçu par email et valide la page "You're one tap away".
export async function confirmMagicLink(page, link) {
  await page.goto(link, { waitUntil: 'load' });
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(u => !u.pathname.startsWith('/auth/'), { timeout: 20000 });
}

export async function generateApiKey(page, { timeout = 20000 } = {}) {
  await page.goto(DEVELOPERS_URL, { waitUntil: 'load' });

  // Premier login : le site redirige vers l'onboarding /welcome.
  if (page.url().includes('/welcome')) {
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await page.waitForTimeout(1500);
    if (!page.url().includes('/developers')) await page.goto(DEVELOPERS_URL, { waitUntil: 'load' });
  }

  const button = page.getByRole('button', { name: /Generate API Key/i }).first();
  await button.waitFor({ state: 'visible', timeout });
  await button.click();

  const key = page.locator('code').filter({ hasText: /^sl_data_[0-9a-f]{32,}$/ }).first();
  await key.waitFor({ state: 'visible', timeout });
  return (await key.innerText()).trim();
}
