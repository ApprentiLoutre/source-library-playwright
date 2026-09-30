# Automatisation Source Library (Playwright)

Automatisation, avec Playwright et Chromium, du parcours d'un utilisateur sur
[sourcelibrary.org](https://sourcelibrary.org) :

1. demande d'un lien de connexion (« magic link ») par email ;
2. confirmation de ce lien et ouverture de session ;
3. génération d'une clé API depuis la page **Developers**.

> Portée : ce dépôt gère **un compte** (le vôtre). Il ne crée pas de comptes
> en masse et ne collecte pas de clés API sur plusieurs comptes. Pour plus de
> quota, passez par les offres payantes ou demandez un accès « bulk » à Source Library.

---

## Structure

```
.
├── lib/
│   ├── signin.mjs          # Étape 1 : requestMagicLink(page, email)
│   └── developers.mjs      # Étapes 2-3 : confirmMagicLink, patchPosthogStub, generateApiKey
├── tests/
│   └── signin.spec.mjs     # Test Playwright de l'étape 1
├── playwright.config.mjs
├── package.json
└── .gitignore              # exclut node_modules, rapports, .auth-state.json, .api-key
```

Fichiers locaux sensibles, jamais versionnés (permissions `600`) :

| Fichier            | Contenu                                                   |
|--------------------|-----------------------------------------------------------|
| `.auth-state.json` | Cookies de session Auth.js (`__Secure-authjs.session-token`…) |
| `.api-key`         | Clé API générée (`sl_data_…`)                             |

---

## Installation

Prérequis : Node.js ≥ 18 (testé avec Node 24).

```bash
npm install                                  # installe @playwright/test
npx playwright install --with-deps chromium  # navigateur + dépendances système
```

---

## Étape 1 : demander le lien de connexion

### Analyse de la page

J'ai d'abord inspecté `https://sourcelibrary.org/auth/signin` avec un script
Playwright qui liste les éléments `input`, `button`, `form` et `a`. Résultat :

- un seul champ : `<input id="email" type="email" required>` ;
- un bouton `<button type="submit" disabled>Continue with Email</button>`,
  **désactivé tant que l'email est vide** ;
- une bannière cookies (`Accept` / `Decline`) qui peut recouvrir le bouton.

La structure correspond à l'ébauche fournie. Les sélecteurs ont donc été conservés
et rendus plus précis.

### Implémentation : `lib/signin.mjs`

`requestMagicLink(page, email)` :

1. ouvre la page de connexion ;
2. ferme la bannière cookies si elle est visible (`Decline`) ;
3. remplit `input#email[type="email"]` ;
4. vérifie que le bouton `form button[type="submit"]` est bien **activé** ;
5. clique en écoutant en parallèle la requête POST d'authentification
   (`Promise.all` pour ne pas manquer la réponse) ;
6. attend le message **« Check your email »** (regex insensible à la casse).

Elle renvoie `{ email, status, url }`.

### Exécution

```bash
TARGET_EMAIL=vous@exemple.com npx playwright test
```

Sans `TARGET_EMAIL`, le test utilise l'adresse par défaut définie dans
`tests/signin.spec.mjs`.

**Résultat vérifié :** `1 passed`. Le serveur a répondu `204` et la page a
affiché « Check your email ».

---

## Étape 2 : confirmer le lien et ouvrir la session

### Constats

Le lien reçu par email passe d'abord par un traceur de clics
(`ilove.sourcelibrary.org/CL0/…`), qui redirige vers :

```
https://sourcelibrary.org/auth/confirm?next=…/api/auth/callback/nodemailer?token=…&email=…
```

Cette page (« You're one tap away ») **n'ouvre pas la session toute seule** : il
faut cliquer sur le lien **Sign in**. Le lien ne sert **qu'une seule fois** et
expire au bout de 24 h.

### Implémentation

`confirmMagicLink(page, link)` dans `lib/developers.mjs` :

1. ouvre le lien ;
2. clique sur `getByRole('link', { name: 'Sign in', exact: true })` ;
3. attend que l'URL quitte `/auth/…`.

La session est ensuite sauvegardée avec
`context.storageState({ path: '.auth-state.json' })`, puis rechargée par
`browser.newContext({ storageState: '.auth-state.json' })`. On n'a donc pas
besoin d'un nouveau lien à chaque exécution.

**Vérification :** après le clic, la redirection mène à `/welcome?from=%2F` et
les cookies `__Secure-authjs.session-token`, `__Host-authjs.csrf-token` et
`__Secure-authjs.callback-url` sont présents.

---

## Étape 3 : générer une clé API

### Problème rencontré : toutes les pages plantaient une fois connecté

Une fois connecté, **toutes** les pages (`/`, `/welcome`, `/developers`)
affichaient « Something went wrong ». Voici comment la cause a été trouvée :

1. **Hypothèse « détection du mode headless » écartée.** Même résultat avec un
   user-agent Chrome standard et une fenêtre 1366×900.
2. **Hypothèse « consentement cookies » écartée.** Même résultat après avoir
   cliqué sur `Accept` puis rechargé la page.
3. **Erreurs console capturées** (`page.on('console')`) :
   ```
   TypeError: s.identify is not a function
   ErrorBoundary caught an error: TypeError: s.identify is not a function
   ```
4. **Lecture du bundle JS** incriminé (`_next/static/immutable/chunks/1f50o46r6zjyj.js`).
   Le code lit `window.posthog` et, dès que l'utilisateur est authentifié,
   appelle `s.identify(userId, {...})` **sans vérifier que la méthode existe**.
5. **Inspection de l'objet dans la page** (`page.evaluate`) :
   `window.posthog` n'est que le *stub* du snippet PostHog (un tableau avec
   seulement `_i`, `init` et `__SV`). La bibliothèque n'est jamais initialisée,
   donc `identify` n'existe pas et l'appel lève une exception que l'ErrorBoundary
   de React transforme en page d'erreur.

Conclusion : **c'est un bug du site**, pas de l'automatisation.

### Contournement : `patchPosthogStub(context)`

Un script d'initialisation (`context.addInitScript`) s'exécute **avant** les
scripts du site. Il remplace `window.posthog` par une propriété avec getter et
setter :

- le setter garde l'objet que le site assigne ;
- le getter lui ajoute des méthodes vides (`identify`, `reset`, `capture`,
  `register`, `setPersonProperties`) **seulement si elles manquent**.

Si PostHog se charge normalement, ses vraies méthodes sont conservées. Sinon,
les appels deviennent sans effet et l'application ne plante plus.

### Page d'accueil au premier login

Au premier login, le site redirige vers `/welcome` (choix de préférences). Le
script clique sur **Skip for now**, puis retourne sur `/developers` si
nécessaire.

### Implémentation : `generateApiKey(page)`

1. ouvre `https://sourcelibrary.org/developers` ;
2. passe l'étape `/welcome` si elle apparaît ;
3. attend puis clique `getByRole('button', { name: /Generate API Key/i })` ;
4. récupère la clé dans le premier `<code>` dont le texte correspond à
   `^sl_data_[0-9a-f]{32,}$` ;
5. renvoie la clé.

**Résultat vérifié :** la clé `sl_data_0106…8c94` a été générée (limite affichée :
60 req/min, palier gratuit « Explorer »). Le site la montre **une seule fois** :
elle a été enregistrée dans `.api-key`.

---

## Exemple d'enchaînement complet

```js
import { chromium } from '@playwright/test';
import { confirmMagicLink, patchPosthogStub, generateApiKey } from './lib/developers.mjs';

const browser = await chromium.launch();
const context = await browser.newContext();
await patchPosthogStub(context);            // à appliquer AVANT toute navigation
const page = await context.newPage();

await confirmMagicLink(page, process.env.MAGIC_LINK);
await context.storageState({ path: '.auth-state.json' });

const key = await generateApiKey(page);     // attention : chaque appel crée une nouvelle clé
console.log(key.slice(0, 16) + '…');
await browser.close();
```

Avec une session déjà enregistrée, on remplace `browser.newContext()` par
`browser.newContext({ storageState: '.auth-state.json' })` et on saute
`confirmMagicLink`.

---

## Utiliser la clé

```bash
# Consommation du quota
curl -H "Authorization: Bearer $(cat .api-key)" https://sourcelibrary.org/api/dataset/v1/usage

# Serveur MCP pour Claude Code
claude mcp add source-library https://sourcelibrary.org/api/mcp \
  -H "Authorization: Bearer $(cat .api-key)"
```

---

## Limites connues

- **Lecture de l'email non automatisée.** Le lien de connexion arrive dans la
  boîte mail et doit être fourni au script (variable `MAGIC_LINK`).
- **Contournement PostHog.** Il dépend du bug actuel du site. S'il est corrigé,
  le patch n'aura simplement plus d'effet.
- **Pas de test automatique pour `generateApiKey`.** Chaque exécution crée une
  vraie clé sur le compte. La fonction a été validée manuellement une fois
  (le module a aussi passé `node --check`).
- **Sélecteurs.** Ils reposent sur le texte visible (« Continue with Email »,
  « Sign in », « Skip for now », « Generate API Key »). Un changement de libellé
  sur le site demandera de les ajuster.
