# Chest SDK — consignes de développement

Ce dépôt est la source du client qu’un outil serveur (contrat v2, le seul)
embarque pour parler avec son Chest. Il appartient à Chest by Argentic ;
le propriétaire est Paul Witczak, on lui écrit en français. Le serveur MCP,
`@argentic/chest-mcp`, a son propre dépôt : `chest-by-argentic/Chest-MCP`.

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

## Ce qui doit rester ensemble

| Si tu changes… | …tu mets à jour |
|---|---|
| `client/src`, `client/test` | les tests (`npm test` et `npm run check:package` verts ; un module ajouté ou renommé : `client/index.ts`, `exports` de `package.json`, la liste de `scripts/check-package.mjs` et le README), puis la copie vendue du dépôt Chest : `npm run sync:sdk` dans `03_code/01_chest-by-argentic` (il écrit `tests/sdk/chest-client/VENDORED.md`), puis chaque outil du store (`03_code/04_argentic-store/<outil>/packages/chest-client`, son `VENDORED.md` nomme le commit) : par `tests/export/export-store.mjs` pour un outil exporté, sinon la même recopie à la main |
| `client/src/member.ts` (l’assertion `Chest-Member`) | `chest/toolfront/assertion.go` du dépôt Chest (dérivation de la clé, revendications) : ils changent ensemble, et le vecteur signé par le Chest de `client/test/member.test.ts` se régénère depuis le Go ; `docs/architecture.md` du dépôt Chest, « Outils serveurs » |
| le contrat (ce qu’un outil serveur reçoit du Chest) | `docs/architecture.md` du dépôt Chest, sections « Outils serveurs » et « Contrat applicatif » ; le README de ce dépôt |

Tout changement d’ici doit donc être synchronisé dans le dépôt Chest et dans
les outils du store par ces scripts ; on ne modifie jamais une copie vendue à
la main.

## Langue et forme

Le SDK est en anglais : code, commentaires, messages d’erreur, `README.md`
(c’est la page du paquet sur npm). Les consignes (`AGENTS.md`) et
`PUBLISHING.md`, écrits pour le propriétaire, sont en français.

TypeScript strict (ES2022, NodeNext). Rien d’autre que les fichiers de
`scripts/sync-sdk.mjs` du dépôt Chest dans `client/src` et `client/test` : ce
script refuse tout fichier en plus (d’où `client/index.ts` à part). Le paquet
npm publie les quatre modules (`errors`, `member`, `database`, `files`). Le
contrat v1 (un worker relié par un canal privé) est retiré du Chest : ni son
client ni son gabarit ne reviennent ici. La version
est celle de `package.json`, publiée par un tag `vX.Y.Z` (`PUBLISHING.md`).
Branche + PR ; les tests doivent passer avant de rendre la main.
