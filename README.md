# Chest SDK

Le SDK est ce qu’un outil embarque pour parler avec son Chest : le canal privé
que le Core lui attache et les trois services qu’il y trouve (outil v1, un
worker), et le membre que le Chest affirme à un outil serveur (outil v2). Il
tient en cinq fichiers TypeScript, sans dépendance :

| Fichier | Rôle |
|---|---|
| `client/src/channel.ts` | `ChestChannel` : un échange HTTP à la fois sur le canal privé (stdout/stdin du worker), réponses bornées, `ChestServiceError` quand le Chest ne confirme pas |
| `client/src/record.ts` | `ChestRecord` : la valeur persistante de l’outil (permission `record`), lue et écrite entière |
| `client/src/requests.ts` | `ChestRequests` et `invocation()` : les invocations que le Chest remet à l’outil (permission `requests`), leur enveloppe validée — `id`, `operation`, `input`, `actor` (`subject`, `manage`, `publish`, `role`), `deadline` — et la réponse |
| `client/src/worker.ts` | `serve` / `runWorker` : la boucle d’un worker, une invocation à la fois, 503 `expired` passée l’échéance, jamais de rejeu d’une écriture au résultat incertain |
| `client/src/member.ts` | `member(request)` : le membre d’une requête de l’hôte d’équipe d’un outil serveur, lu dans l’assertion `Chest-Member` et vérifié ; `null` sans assertion valable |

`client/test/worker.test.ts` éprouve la boucle sur un canal simulé ;
`client/test/member.test.ts` lit une assertion signée par le Chest lui-même
(vecteur produit par `chest/toolfront`) et refuse tout le reste.
`template/` est le gabarit du projet qu’un auteur d’outil reçoit (voir plus bas).

## Le contrat, en bref

Le Core choisit l’instance de l’outil et lui attache ses pipes privés ; le
worker demande ses services par HTTP sur ces pipes, et rien d’autre : aucun
serveur HTTP, aucune sortie réseau, aucun secret. Les droits viennent
uniquement de l’enveloppe transmise par le Chest — un champ métier n’accorde
jamais un droit — et le broker du Chest applique les permissions du manifeste
même hors SDK : le SDK facilite les appels, il n’est pas une frontière de
sécurité. Le contrat complet (permissions, manifeste `chest.json`, construction
depuis le code, catalogue) est décrit dans le dépôt Chest,
`docs/architecture.md`, section « Contrat applicatif actuel ».

## `member(request)` — outil serveur (contrat v2)

Un outil v2 est un serveur web ordinaire ; sur son hôte d’équipe, le Chest
relaie `/chest` et ce qui est dessous avec l’en-tête `Chest-Member` du membre
connecté. `member(request)` accepte une requête Node (`IncomingMessage`) ou
Web (`Request`) et rend :

```ts
type Member = { id: string; firstName: string; lastName: string; name: string; email: string; photo?: string; role?: string; isAdmin: boolean; isBuilder: boolean };
```

ou `null` : sans en-tête, sur l’hôte public (le Chest n’y envoie jamais
d’assertion et retire celle d’un client), ou pour toute assertion qui n’est
pas exactement la sienne. Vérifications : JWS compact, en-tête exactement
`{"alg":"HS256","typ":"JWT"}`, signature HMAC-SHA256 comparée en temps
constant sous la clé HMAC-SHA256(« Chest-Member v1 ») du texte de
`CHEST_TOKEN` — la dérivation du Chest —, `aud` égal à `CHEST_TOOL`, `iat` et
`exp` à 5 s près, forme de chaque revendication (une revendication inconnue
est ignorée). Sans `CHEST_TOKEN` ou `CHEST_TOOL`, personne n’est membre. La
fonction ne lève jamais d’erreur pour ce qu’une requête porte.

```ts
import { member } from "../../packages/chest-client/src/member.js";
const who = member(request);
if (!who) { response.writeHead(401).end(); return; }
```

`photo` est l’adresse de la photo sur l’hôte d’équipe, `role` le rôle que le
Chest donne au membre parmi ceux que le manifeste déclare. Seul le frontal du
Chest joint le conteneur : la signature est une seconde défense ; les règles
métier (qui écrit quoi) restent celles de l’outil.

## Comment un outil l’embarque aujourd’hui

Le SDK n’est pas publié sur npm. Un outil en porte une **copie vendue** de
`client/src` (et `client/test`) sous `packages/chest-client`, compilée avec
ses propres sources :

- dans le dépôt Chest, `tests/sdk/chest-client` et `tests/creator` sont
  remis à jour depuis ce dépôt par `npm run sync:sdk`
  (`scripts/sync-sdk.mjs`), qui écrit leur `VENDORED.md` ;
- un projet de départ est assemblé par `tests/export/export-creator.mjs` du
  dépôt Chest (ce gabarit + le client + l’outil d’exemple `apps/testapp`) ;
- un outil est exporté par `tests/export/export-store.mjs`, qui y copie le
  client ; les outils du store (`chest-by-argentic/forms`, le banc d’essai
  `PaulWCZ/TestAppChestGithub`…) gardent la même disposition,
  `packages/chest-client` avec son `VENDORED.md`.

## Version

La version du SDK est le commit Git de ce dépôt. Chaque copie vendue porte un
`VENDORED.md` qui nomme ce commit et la date de la copie ; c’est là qu’on lit
quelle version un outil embarque.

## Ce que ce dépôt n’est pas

Ce dépôt est public et **n’est pas un outil** : il n’a pas de `chest.json`, et
le catalogue d’un Chest — qui ne liste que les dépôts publics de
l’organisation porteurs d’un manifeste — ne le propose jamais.

## Développer

```sh
npm ci
npm test
```

`npm test` compile (`tsc`, strict, ES2022, NodeNext) puis lance
`node --test dist/client/test/*.test.js`. Lire `AGENTS.md` avant de modifier.

Licence : à fixer par le propriétaire (Argentic) ; aucune licence n’est
encore déclarée.
