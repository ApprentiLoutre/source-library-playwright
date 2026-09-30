// Gère un navigateur Playwright persistant pour le parcours interactif complet :
//   reset -> demande de magic link -> confirmation -> génération de clé API.
//
// Un seul contexte de navigateur à la fois. `reset()` le détruit complètement
// (cookies, session) afin de pouvoir créer/connecter un nouveau compte.
import { chromium } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requestMagicLink, SIGNIN_URL } from './signin.mjs';
import {
  confirmMagicLink,
  patchPosthogStub,
  generateApiKey,
  DEVELOPERS_URL,
} from './developers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_STATE = path.join(ROOT, '.auth-state.json');
const API_KEY_FILE = path.join(ROOT, '.api-key');

export const WORKFLOW_STEPS = [
  'idle',
  'awaiting_email', // contexte prêt, en attente de l'email
  'email_sent', // magic link demandé, en attente du lien reçu par email
  'signed_in', // session ouverte
  'key_generated', // clé API récupérée
  'error',
];

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export class Workflow {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.status = 'idle';
    this.message = 'Aucun navigateur actif. Cliquez sur « Démarrer / Réinitialiser ».';
    this.email = null;
    this.apiKey = null;
    this.lastError = null;
    this.signedInUrl = null;
    this.logs = [];
    this._busy = false;
  }

  log(entry) {
    const line = { at: new Date().toISOString(), ...entry };
    this.logs.push(line);
    if (this.logs.length > 200) this.logs.shift();
    const tag = entry.level === 'error' ? 'ERR' : entry.level === 'warn' ? 'WRN' : 'INF';
    console.log(`[${tag}] ${entry.text}`);
  }

  snapshot() {
    return {
      status: this.status,
      message: this.message,
      email: this.email,
      apiKey: this.apiKey,
      lastError: this.lastError,
      signedInUrl: this.signedInUrl,
      browserOpen: Boolean(this.page),
      logs: this.logs.slice(-40),
    };
  }

  setStatus(status, message) {
    this.status = status;
    this.message = message;
    this.log({ level: status === 'error' ? 'error' : 'info', text: message });
  }

  async _ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return;
    this.log({ text: 'Lancement de Chromium…' });
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }

  async _attachContext(context) {
    await patchPosthogStub(context);
    this.context = context;
    this.page = await context.newPage();
    this.page.setDefaultTimeout(30000);
    this.page.on('console', msg => {
      if (msg.type() === 'error') this.log({ level: 'warn', text: `console: ${msg.text().slice(0, 300)}` });
    });
    this.page.on('pageerror', err =>
      this.log({ level: 'warn', text: `pageerror: ${String(err).slice(0, 300)}` }));
    return this.page;
  }

  // Réinitialise entièrement le contexte navigateur : nouveau compte possible.
  async reset({ reloadSession = false } = {}) {
    this.log({ text: 'Réinitialisation du contexte navigateur…' });
    try {
      if (this.context) await this.context.close().catch(() => {});
    } catch {}
    this.context = null;
    this.page = null;
    this.email = null;
    this.apiKey = null;
    this.lastError = null;
    this.signedInUrl = null;
    // Supprime la session et la clé persistées sur disque.
    await fs.rm(AUTH_STATE, { force: true }).catch(() => {});
    await fs.rm(API_KEY_FILE, { force: true }).catch(() => {});
    await this._ensureBrowser();

    if (reloadSession && (await fileExists(AUTH_STATE))) {
      this.log({ text: 'Chargement de la session existante…' });
      await this._attachContext(await this.browser.newContext({ storageState: AUTH_STATE }));
      this.setStatus('signed_in', 'Session existante rechargée. Vous pouvez générer une clé API.');
    } else {
      await this._attachContext(await this.browser.newContext());
      this.setStatus(
        'awaiting_email',
        'Contexte vierge prêt. Saisissez l’email pour demander le lien de connexion.',
      );
    }
    return this.snapshot();
  }

  // Étape 1 : demande du magic link.
  async requestEmail(email) {
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error('Adresse email invalide.');
    }
    if (!this.page) await this.reset();
    this.email = email;
    this.log({ text: `Demande de lien de connexion pour ${email}…` });
    try {
      const result = await requestMagicLink(this.page, email);
      this.log({
        text: `Formulaire soumis (HTTP ${result.status ?? '?'}) : « Check your email » affiché.`,
      });
      this.setStatus(
        'email_sent',
        `Lien envoyé à ${email}. Ouvrez votre boîte mail et collez ici le lien reçu (ou l’URL de redirection).`,
      );
      return this.snapshot();
    } catch (err) {
      this.lastError = String(err?.message ?? err);
      this.setStatus('error', `Échec de la demande de lien : ${this.lastError}`);
      throw err;
    }
  }

  // Étape 2 : confirmation du lien et ouverture de session.
  async confirmLink(link) {
    if (!link || !/^https?:\/\//i.test(link.trim())) {
      throw new Error('Lien invalide : il doit commencer par http(s)://');
    }
    if (!this.page) await this.reset();
    const clean = link.trim();
    this.log({ text: 'Ouverture du lien de connexion…' });
    try {
      await confirmMagicLink(this.page, clean);
      await this.context.storageState({ path: AUTH_STATE });
      await fs.chmod(AUTH_STATE, 0o600).catch(() => {});
      this.signedInUrl = this.page.url();
      this.log({ text: `Session ouverte. URL : ${this.signedInUrl}` });
      this.setStatus('signed_in', 'Connecté. Cliquez sur « Générer la clé API » pour continuer.');
      return this.snapshot();
    } catch (err) {
      this.lastError = String(err?.message ?? err);
      this.setStatus('error', `Échec de la confirmation du lien : ${this.lastError}`);
      throw err;
    }
  }

  // Étape 3 : génération de la clé API (le lien magique ne sert qu'une fois).
  async generateKey() {
    if (!this.page) await this.reset();
    this.log({ text: `Ouverture de ${DEVELOPERS_URL}…` });
    try {
      const key = await generateApiKey(this.page);
      this.apiKey = key;
      await fs.writeFile(API_KEY_FILE, key + '\n', { mode: 0o600 }).catch(() => {});
      this.log({ text: `Clé API générée : ${key.slice(0, 16)}… (affichée une seule fois).` });
      this.setStatus('key_generated', 'Clé API générée avec succès. Copiez-la maintenant !');
      return this.snapshot();
    } catch (err) {
      this.lastError = String(err?.message ?? err);
      this.setStatus(
        'error',
        `Échec de la génération de la clé : ${this.lastError}. Vérifiez que vous êtes bien connecté.`,
      );
      throw err;
    }
  }

  // Ouvre la session persistée (si présente) sans repasser par l'email.
  async loadStored() {
    const snap = await this.reset({ reloadSession: true });
    return snap;
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}