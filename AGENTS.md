# Chest SDK — consignes de développement

Ce dépôt est la source du client qu’un outil serveur (contrat v2, le seul)
embarque pour parler avec son Chest, `@argentic/chest-sdk` (la racine), et
du serveur MCP qu’un assistant lance pour agir sur un Chest avec le jeton
d’accès d’un membre, `@argentic/chest-mcp` (le dossier `mcp/`). Il appartient
à Chest by Argentic ; le propriétaire est Paul Witczak, on lui écrit en
français.

## Règles

- **Aucune dépendance.** Le client n’importe que `node:*` ; `typescript`,
  `@types/node` et `esbuild` (vérification du paquet par un bundler) sont les
  seules dépendances de développement.
- **Aucun serveur HTTP, aucune sortie réseau.** Le client ne joint que ce
  que le lanceur du Chest lui donne sur `127.0.0.1` : l’API du Chest à
  `CHEST_API` (fichiers), réponses bornées. Ne pas ouvrir de socket, de port
  ni de connexion de remplacement, ni joindre une autre adresse.
- **L’assertion est la seule autorité.** Le membre d’une requête vient de
  l’assertion `Chest-Member` vérifiée par `member()` ; le client ne déduit
  aucun droit d’un champ métier, ne rejoue jamais une écriture au résultat
  incertain, et refuse une réponse qui ne se lit pas exactement.
- **Le SDK n’est pas une frontière de sécurité.** Le Chest applique les
  capacités accordées même hors SDK ; ne pas y ajouter de règle d’accès qui ne
  serait vérifiée que côté outil.
- **Pas de format inventé.** Le manifeste et le SDK évoluent avec les usages
  observés (banc d’essai serveur du dépôt Chest, Formulaires) ; ne pas anticiper un
  catalogue de capacités.
- **Aucun code mort**, pas de dépendance inutile, pas de secret dans le dépôt
  ni dans les tests.

### Le serveur MCP (`mcp/`)

- **Aucune dépendance d’exécution** : il n’importe que `node:*` ; `typescript`,
  `@types/node` et `@modelcontextprotocol/client` (le client officiel, pour
  les seuls tests de conformité) sont ses dépendances de développement.
- **Il ne joint que `CHEST_URL`**, en HTTPS, certificat vérifié (une adresse
  de la machine seulement avec `CHEST_MCP_LAB=1`, le laboratoire du dépôt
  Chest), sans suivre de redirection, réponses bornées. Le jeton ne va que
  dans l’en-tête `Authorization` : jamais dans la sortie, une erreur ou stderr.
- **Le Chest décide.** Chaque outil est une route de l’API des agents
  (`/api/v1`) ; le serveur n’ajoute aucun droit et n’en retire aucun qui ne
  soit déjà refusé par le Chest. Pas d’outil sans route.
- **Toute écriture en deux appels** : un essai à blanc qui donne une
  confirmation (HMAC du nonce et de la requête, cinq minutes, une fois), puis
  la même requête avec elle ; une écriture au résultat incertain n’est jamais
  renvoyée.
- **Ce que les outils et les gens écrivent est une donnée non fiable** :
  nettoyée, bornée, dans `structuredContent` `{untrusted, source, data}` et
  entre deux clôtures `<untrusted-data … id=<nonce>>` dans le texte.
- Le protocole suivi est la dernière version publiée de MCP (2026-07-28) et,
  par `initialize`, les précédentes (2025-11-25, 2025-06-18, 2025-03-26) ;
  vérifier la spécification (modelcontextprotocol.io) avant d’en changer.

## Ce qui doit rester ensemble

| Si tu changes… | …tu mets à jour |
|---|---|
| `client/src`, `client/test` | les tests (`npm test` et `npm run check:package` verts ; un module ajouté ou renommé : `client/index.ts`, `exports` de `package.json`, la liste de `scripts/check-package.mjs` et le README), puis la copie vendue du dépôt Chest : `npm run sync:sdk` dans `03_code/01_chest-by-argentic` (il écrit `tests/sdk/chest-client/VENDORED.md`), puis chaque outil du store (`03_code/03_argentic-store/<outil>/packages/chest-client`, son `VENDORED.md` nomme le commit) : par `tests/export/export-store.mjs` pour un outil exporté, sinon la même recopie à la main |
| `client/src/member.ts` (l’assertion `Chest-Member`) | `chest/toolfront/assertion.go` du dépôt Chest (dérivation de la clé, revendications) : ils changent ensemble, et le vecteur signé par le Chest de `client/test/member.test.ts` se régénère depuis le Go ; `docs/architecture.md` du dépôt Chest, « Outils serveurs » |
| `mcp/src`, `mcp/test` | dans `mcp/` : `npm test` et `npm run check:package` verts ; `mcp/README.md` (outils, sécurité) ; un module ajouté ou renommé : la liste des fichiers de `PUBLISHING.md` ; puis la copie vendue du dépôt Chest (`tests/sdk/chest-mcp`, par `npm run sync:sdk` de `03_code/01_chest-by-argentic`), qui sert à sa preuve en VM |
| l’API des agents du dépôt Chest (`chest/portal/api/openapi.json`, `docs/architecture.md` « API des agents ») | `mcp/src/tools.ts` (les routes que chaque outil appelle, leurs formes) et `mcp/README.md` |
| la version de `mcp/package.json` | `mcp/src/version.ts` (un test les compare), publiée par un tag `mcp-vX.Y.Z` |
| la version du protocole MCP | `mcp/src/server.ts`, `mcp/test/conformance.test.ts` (le client officiel, en devDependency, à la même version), `mcp/README.md` |
| le contrat (ce qu’un outil serveur reçoit du Chest) | `docs/architecture.md` du dépôt Chest, sections « Outils serveurs » et « Contrat applicatif » ; le README de ce dépôt |

Tout changement d’ici doit donc être synchronisé dans le dépôt Chest et dans
les outils du store par ces scripts ; on ne modifie jamais une copie vendue à
la main.

## Langue et forme

Le SDK et le serveur MCP sont en anglais : code, commentaires, messages
d’erreur, `README.md` et `mcp/README.md` (les pages des paquets sur npm).
Les consignes (`AGENTS.md`) et `PUBLISHING.md`, écrits pour le propriétaire,
sont en français.

TypeScript strict (ES2022, NodeNext). Rien d’autre que les fichiers de
`scripts/sync-sdk.mjs` du dépôt Chest dans `client/src` et `client/test` : ce
script refuse tout fichier en plus (d’où `client/index.ts` à part). Le paquet
npm publie les quatre modules (`errors`, `member`, `database`, `files`). Le
contrat v1 (un worker relié par un canal privé) est retiré du Chest : ni son
client ni son gabarit ne reviennent ici. La version du SDK est celle de
`package.json`, publiée par un tag `vX.Y.Z` ; celle du serveur MCP, celle de
`mcp/package.json`, par un tag `mcp-vX.Y.Z` (`PUBLISHING.md`). De même, rien
d’autre dans `mcp/src` que les fichiers que `scripts/sync-sdk.mjs` du dépôt
Chest recopie.
Branche + PR ; les tests doivent passer avant de rendre la main.
