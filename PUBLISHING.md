# Publier `@argentic/chest-sdk` sur npm

Pour Paul. Le paquet se publie depuis le compte npm `paulwcz`, propriétaire de
l’organisation npm `argentic`. Trois temps :

1. **la première version (0.1.0) à la main**, une seule fois : npm ne permet de
   régler la publication de confiance (« trusted publishing ») que sur un
   paquet qui existe déjà ;
2. **brancher GitHub Actions** sur le paquet, sur npmjs.com ;
3. **ensuite, chaque version part d’un tag** `vX.Y.Z`, sans jeton ni mot de
   passe : GitHub prouve à npm que c’est bien `publish.yml` de ce dépôt qui
   publie, et npm attache au paquet la preuve de provenance.

Aucun jeton npm (`NPM_TOKEN`) n’est créé ni rangé nulle part, ni dans GitHub ni
dans ce dépôt.

Vérifié le 2026-09-25 dans la documentation npm
([Trusted publishing](https://docs.npmjs.com/trusted-publishers),
[`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/)) : npm CLI
11.5.1 ou plus et Node 22.14.0 ou plus côté GitHub Actions, permission
`id-token: write`, champs « Organization or user », « Repository »,
« Workflow filename », « Environment name » (facultatif), le champ
`repository.url` de `package.json` qui doit correspondre exactement au dépôt
GitHub, la provenance réservée aux dépôts publics, et l’option « Require
two-factor authentication and disallow tokens ».

---

## 1. Première publication, à la main

### Avant de commencer

- Le compte `paulwcz` a la double authentification (2FA) activée : sur
  npmjs.com, avatar en haut à droite → **Account** → **Two-Factor
  Authentication**.
- Node 22 ou plus sur le Mac (`node --version`). La version de npm n’importe
  pas pour cette étape.
- **La PR #5 (« Publish on npm as @argentic/chest-sdk 0.1.0 ») est
  fusionnée dans `main`.** Pas avant : tant qu’elle ne l’est pas, `main` porte
  encore `"private": true` et aucune version, et npm refuse avec `EPRIVATE`
  (« This package has been marked as private »).

### Se connecter à npm

```sh
npm login
```

npm affiche `Login at: https://www.npmjs.com/login?next=/login/cli/…` et
propose d’ouvrir le navigateur (touche Entrée). Dans le navigateur : se
connecter à `paulwcz`, saisir le code 2FA, puis **Sign in** / confirmer. Le
terminal affiche `Logged in on https://registry.npmjs.org/.` Vérifier :

```sh
npm whoami          # doit répondre : paulwcz
npm org ls argentic # doit lister paulwcz (owner)
```

### Publier depuis un `main` propre

Toujours depuis une copie propre de `main` fusionné, jamais depuis une branche
ou un dossier avec des modifications en cours :

```sh
cd ~/Documents/Chest-by-Argentic/03_code/02_chest-sdk
git switch main
git pull --ff-only
git status          # doit dire : nothing to commit, working tree clean
node -p "require('./package.json').name+'@'+require('./package.json').version"
                    # doit afficher exactement : @argentic/chest-sdk@0.1.0
npm ci
npm test
npm publish --dry-run --provenance=false   # répétition : liste les fichiers, n’envoie rien
npm publish --access public --provenance=false
```

Si la commande `node -p …` affiche autre chose (par exemple
`chest-sdk@undefined`), s’arrêter : la PR #5 n’est pas encore fusionnée, ou
`git pull` n’a pas été fait. `npm publish` échouerait avec `EPRIVATE`.

La répétition doit lister 28 fichiers : `LICENSE`, `README.md`,
`package.json`, `client/index.ts`, `client/src/{database,errors,files,member}.ts`
et `dist/` (`index` et ces quatre modules, `.js`, `.d.ts` et leurs `.map`).

Ce que fait `npm publish` : il relance d’abord les tests et la vérification du
paquet (`prepublishOnly` : `npm test` puis `npm run check:package`, quelques
secondes), recompile `dist/` (`prepack`), puis envoie le paquet.

Pourquoi `--provenance=false` : `package.json` demande la provenance
(`publishConfig.provenance: true`) pour les publications de GitHub Actions. La
provenance est une attestation signée par la CI (GitHub) : elle ne peut pas
être produite depuis un Mac, et `npm publish` échouerait avec une erreur du
type « provenance generation not supported for provider: null ». On la coupe
donc pour cette seule publication manuelle ; la 0.1.0 n’aura pas le badge
« Provenance », les suivantes l’auront.

**Le code 2FA.** Au moment d’envoyer, npm demande une confirmation 2FA, selon
la configuration du compte :

- soit `This operation requires a one-time password.` puis
  `Enter OTP:` → taper le code à 6 chiffres de l’application
  d’authentification, puis Entrée ;
- soit `Authenticate your account at: https://www.npmjs.com/auth/cli/…` et
  `Press ENTER to open in the browser...` → Entrée, confirmer dans le
  navigateur (code 2FA ou clé de sécurité), revenir au terminal.

Le terminal finit par `+ @argentic/chest-sdk@0.1.0`. Vérifier :

```sh
npm view @argentic/chest-sdk
```

et la page <https://www.npmjs.com/package/@argentic/chest-sdk> (version 0.1.0,
licence MIT, README).

---

## 2. Brancher GitHub Actions (trusted publishing)

Sur npmjs.com, connecté en `paulwcz` :

1. Ouvrir <https://www.npmjs.com/package/@argentic/chest-sdk>.
2. Onglet **Settings** du paquet (à droite des onglets Readme, Code,
   Dependencies…).
3. Section **Trusted Publisher** → **Select your publisher** → bouton
   **GitHub Actions**.
4. Remplir, exactement (la casse compte) :
   - **Organization or user** : `chest-by-argentic`
   - **Repository** : `Chest-SDK`
   - **Workflow filename** : `publish.yml` (le nom seul, sans
     `.github/workflows/`)
   - **Environment name** : laisser vide
   - **Allowed actions**, si la ligne apparaît : cocher la publication
     directe (`npm publish`) ; `npm stage publish` est toujours permis.
5. Valider (bouton **Set up connection**, ou libellé voisin). npm peut
   redemander le code 2FA.

Puis, sur la même page **Settings**, section **Publishing access** :

6. Choisir **Require two-factor authentication and disallow tokens**, puis
   **Update Package Settings**. Conseillé : plus aucun jeton ne peut publier
   ce paquet ; seuls GitHub Actions (par la connexion de confiance) et `paulwcz`
   avec son 2FA le peuvent.

En ligne de commande, la même connexion se règle aussi avec npm 11.15.0 ou plus
(2FA activée, paquet existant) :

```sh
npm trust github @argentic/chest-sdk --file publish.yml --repo chest-by-argentic/Chest-SDK --allow-publish
```

---

## 3. Les versions suivantes

1. Dans une PR, changer la version (le `package-lock.json` suit) :

   ```sh
   npm version 0.1.1 --no-git-tag-version
   ```

   Règle : `0.1.x` pour une correction, `0.2.0` pour un ajout ou un changement
   d’API tant qu’on est avant la 1.0.
2. Fusionner la PR (la CI « CI » doit être verte).
3. Poser le tag sur `main` fusionné et le pousser :

   ```sh
   git switch main
   git pull --ff-only
   git tag v0.1.1
   git push origin v0.1.1
   ```

   — ou demander à Claude : « publie la 0.1.1 du SDK ».
4. Suivre sur GitHub : dépôt `chest-by-argentic/Chest-SDK` → onglet
   **Actions** → workflow **Publish**. Il vérifie que le tag est égal à la
   version de `package.json`, installe npm 11, lance les tests et la
   vérification du paquet, puis publie avec provenance. Sur npmjs.com, la
   version porte ensuite le badge **Provenance**, qui renvoie au commit et au
   workflow.

Si le tag ne correspond pas à `package.json`, le workflow s’arrête avant de
publier. Retirer le mauvais tag puis recommencer :

```sh
git tag -d v0.1.1
git push origin --delete v0.1.1
```

Une version publiée ne se republie jamais sous le même numéro : en cas
d’erreur, publier la suivante. `npm deprecate @argentic/chest-sdk@0.1.1 "…"`
signale une version fautive ; `npm unpublish` n’est possible que dans les 72 h
et sous conditions, à éviter.
