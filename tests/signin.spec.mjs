import { test, expect } from '@playwright/test';
import { requestMagicLink } from '../lib/signin.mjs';

const targetEmail = process.env.TARGET_EMAIL ?? 'begenin189@aminavin.com';

test('submits signin form and triggers magic link', async ({ page }) => {
  const result = await requestMagicLink(page, targetEmail);
  console.log(result);
  await expect(page.getByText(/check your email/i).first()).toBeVisible();
});
