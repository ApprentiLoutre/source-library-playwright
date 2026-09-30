// Soumet le formulaire "magic link" de sourcelibrary.org pour un email donné.
export const SIGNIN_URL = 'https://sourcelibrary.org/auth/signin';

export async function requestMagicLink(page, email, { timeout = 15000 } = {}) {
  await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded' });

  // Ferme la bannière cookies si elle est présente (elle peut couvrir le bouton).
  const decline = page.getByRole('button', { name: 'Decline', exact: true });
  if (await decline.isVisible().catch(() => false)) await decline.click();

  const emailInput = page.locator('input#email[type="email"]');
  const submit = page.locator('form button[type="submit"]');

  await emailInput.fill(email);
  await submit.waitFor({ state: 'visible' });
  if (!(await submit.isEnabled())) throw new Error('Submit button still disabled after fill');

  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' && /auth/.test(r.url()), { timeout })
      .catch(() => null),
    submit.click(),
  ]);

  const status = response?.status() ?? null;

  // Le serveur répond 429 « Too many sign-in requests » quand la limite de
  // demandes est atteinte : on remonte ce message précis plutôt qu'un timeout.
  if (status === 429) {
    let apiError = 'Trop de demandes de connexion (HTTP 429).';
    try {
      const data = await response.json();
      if (data?.error) apiError = data.error;
    } catch {}
    throw new Error(
      `${apiError} La limite de demandes de lien est atteinte pour cette adresse/IP ; ` +
        `patientez puis réessayez.`,
    );
  }

  // Succès attendu : le message « Check your email » ; en cas d'échec le site
  // affiche « Could not send sign-in link. Please try again. ».
  const success = page.getByText(/check your email/i).first();
  const failure = page.getByText(/could not send sign-in link/i).first();

  await Promise.race([
    success.waitFor({ state: 'visible', timeout }),
    failure.waitFor({ state: 'visible', timeout }).then(() => {
      throw new Error("Le site n'a pas pu envoyer le lien (échec côté serveur).");
    }),
  ]).catch(err => {
    if (err?.message?.startsWith('Le site')) throw err;
    throw new Error(
      /could not send sign-in link/i.test(page.url())
        ? "Le site n'a pas pu envoyer le lien."
        : `Aucune confirmation « Check your email » après ${timeout} ms (HTTP ${status ?? '?'}).`,
    );
  });

  return { email, status, url: page.url() };
}