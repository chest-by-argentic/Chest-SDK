# Chest SDK — consignes de développement

Ce dépôt est la source du client qu’un outil embarque pour parler avec son
Chest, et du gabarit du projet de départ. Il appartient à Chest by Argentic ;
le propriétaire est Paul Witczak, on lui écrit en français.

## Règles

- **Aucune dépendance.** Le client n’importe que `node:*` ; `typescript` et
  `@types/node` sont les seules dépendances de développement.
- **Aucun serveur HTTP, aucune sortie réseau.** Le client parle sur le canal
  privé que le Chest lui attache (stdout/stdin), un échange à la fois, réponses
  bornées. Ne pas ouvrir de socket, de port ni de connexion de remplacement.
- **L’enveloppe est la seule autorité.** Les droits d’une invocation viennent
  de l’enveloppe validée par `invocation()` ; le client ne déduit aucun droit
  d’un champ métier, ne rejoue jamais une écriture au résultat incertain, et
  refuse une enveloppe qui ne se lit pas exactement.
- **Le SDK n’est pas une frontière de sécurité.** Le broker du Chest applique
  les permissions même hors SDK ; ne pas y ajouter de règle d’accès qui ne
  serait vérifiée que côté outil.
- **Pas de format inventé.** Le manifeste et le SDK évoluent avec les usages
  observés (banc d’essai du dépôt Chest, Formulaires) ; ne pas anticiper un
  catalogue de capacités.
- **Aucun code mort**, pas de dépendance inutile, pas de secret dans le dépôt
  ni dans les tests.

## Ce qui doit rester ensemble

| Si tu changes… | …tu mets à jour |
|---|---|
| `client/src`, `client/test` | les tests (`npm test` vert), puis la copie vendue du dépôt Chest : `npm run sync:sdk` dans `03_code/01_chest-by-argentic` (il écrit `tests/sdk/chest-client/VENDORED.md` et `tests/creator/VENDORED.md`), puis chaque outil du store (`03_code/03_argentic-store/<outil>/packages/chest-client`, son `VENDORED.md` nomme le commit) : par `tests/export/export-store.mjs` pour un outil exporté, sinon la même recopie à la main |
| `template/*` | la copie du dépôt Chest (`templates/creator`, même script `sync-sdk.mjs`), et son test `tests/creator/export.test.mjs` s’il liste les fichiers |
| `client/src/member.ts` (l’assertion `Chest-Member`) | `chest/toolfront/assertion.go` du dépôt Chest (dérivation de la clé, revendications) : ils changent ensemble, et le vecteur signé par le Chest de `client/test/member.test.ts` se régénère depuis le Go ; `docs/architecture.md` du dépôt Chest, « Outils serveurs » |
| le contrat (ce que le canal demande, l’enveloppe) | `docs/architecture.md` du dépôt Chest, section « Contrat applicatif actuel » ; le README de ce dépôt |

Tout changement d’ici doit donc être synchronisé dans le dépôt Chest et dans
les outils du store par ces scripts ; on ne modifie jamais une copie vendue à
la main.

## Langue et forme

Documentation en français ; commentaires de code et messages d’erreur en
anglais. TypeScript strict (ES2022, NodeNext). Branche + PR ; les tests
doivent passer avant de rendre la main.
