# Chest SDK

Le SDK est ce qu’un outil embarque pour parler avec son Chest : le canal privé
que le Core lui attache et les trois services qu’il y trouve (outil v1, un
worker), et, pour un outil serveur (outil v2), le membre que le Chest lui
affirme, l’adresse de sa base de données et ses fichiers. Il tient en huit
fichiers TypeScript, sans dépendance :

| Fichier | Rôle |
|---|---|
| `client/src/channel.ts` | `ChestChannel` : un échange HTTP à la fois sur le canal privé (stdout/stdin du worker), réponses bornées, `ChestServiceError` quand le Chest ne confirme pas |
| `client/src/record.ts` | `ChestRecord` : la valeur persistante de l’outil (permission `record`), lue et écrite entière |
| `client/src/requests.ts` | `ChestRequests` et `invocation()` : les invocations que le Chest remet à l’outil (permission `requests`), leur enveloppe validée — `id`, `operation`, `input`, `actor` (`subject`, `manage`, `publish`, `role`), `deadline` — et la réponse |
| `client/src/worker.ts` | `serve` / `runWorker` : la boucle d’un worker, une invocation à la fois, 503 `expired` passée l’échéance, jamais de rejeu d’une écriture au résultat incertain |
| `client/src/member.ts` | `member(request)` : le membre d’une requête de l’hôte d’équipe d’un outil serveur, lu dans l’assertion `Chest-Member` et vérifié ; `null` sans assertion valable |
| `client/src/database.ts` | `databaseUrl()` : l’adresse de la base PostgreSQL propre à l’outil serveur (capacité `database`) ; `CapabilityNotGranted` sans elle |
| `client/src/files.ts` | `put`, `get`, `list`, `delete`, `url` : les fichiers privés de l’outil serveur (capacité `files`), gardés par le Chest, et un lien signé de 15 minutes vers l’un d’eux |
| `client/src/errors.ts` | `ChestError` (`code`, `status`), `CapabilityNotGranted` (403, `capability_not_granted`), `TooLarge` (413), `QuotaExceeded` (429), `Unavailable` (503) : ce que le SDK lève quand le Chest ne donne pas ce qu’un outil demande |

`client/test/worker.test.ts` éprouve la boucle sur un canal simulé ;
`client/test/member.test.ts` lit une assertion signée par le Chest lui-même
(vecteur produit par `chest/toolfront`) et refuse tout le reste ;
`client/test/database.test.ts` lit l’adresse que donne le lanceur du Chest et
refuse toute autre ; `client/test/files.test.ts` joue l’API du Chest en
mémoire (routes et codes du broker) et vérifie que rien ne part sans
`CHEST_API` ni avec un nom hors grammaire.
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

## `databaseUrl()` — base de données d’un outil serveur

Un outil v2 qui déclare `"capabilities": ["database"]` dans son `chest.json`
reçoit une base PostgreSQL à lui seul (la capacité est montrée et approuvée
comme une permission, « Base de données »). Le conteneur n’a pas de réseau :
son lanceur écoute sur `127.0.0.1` et relaie chaque connexion au Chest. Le
lanceur pose `DATABASE_URL` —
`postgres://<utilisateur>:<mot de passe>@127.0.0.1:<port>/<base>?sslmode=disable`,
l’utilisateur et la base portant le même nom `t_<outil>` — et `PGHOST`,
`PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, qui priment sur une variable
de l’outil du même nom. `databaseUrl()` rend `DATABASE_URL` s’il a exactement
cette forme, et lève `CapabilityNotGranted` sinon (version sans la capacité,
ou `DATABASE_URL` propre à l’outil). La valeur est un secret : ne jamais la
journaliser ni l’envoyer au navigateur.

Le SDK n’embarque pas de client PostgreSQL : l’outil choisit le sien, par
exemple [`postgres`](https://github.com/porsager/postgres) (porsager, sans
dépendance) ou [`pg`](https://node-postgres.com) :

```ts
import postgres from "postgres";
import { databaseUrl } from "../../packages/chest-client/src/database.js";
const sql = postgres(databaseUrl(), { max: 5 });
const notes = await sql`SELECT id, text FROM notes ORDER BY id`;
```

Dix connexions au plus par instance ; une requête de plus de 30 s, une
transaction inactive plus de 60 s sont interrompues par le Chest.
**Migrations** : les fichiers `migrations/NNNN_nom.sql` du dépôt
(`^[0-9]{4}_[a-z0-9_-]{1,64}\.sql$`, 256 au plus, 1 Mio chacun) sont joués
par le Chest, dans l’ordre, chacun dans sa transaction, à l’installation et à
chaque mise à jour, avant que la nouvelle version reçoive le trafic ; un
fichier en échec garde la version en service. Le Chest tient la liste des
fichiers joués (table `chest_migrations`) : une version qui en perd un ou en
change un est refusée. Une migration doit laisser la version précédente
fonctionner — le retour à la version précédente ne défait rien.

## `files` — fichiers d’un outil serveur

Un outil v2 qui déclare `"capabilities": ["files"]` (« Fichiers » à
l’approbation) garde des fichiers privés **par son Chest**, jamais sur son
disque (la racine du conteneur est en lecture seule) : 1 Gio et 10 000
objets par outil, 32 Mio par objet. Le lanceur donne à l’outil
`CHEST_API=http://127.0.0.1:<port>` — son propre port, relayé au Chest ; le
conteneur n’a pas de réseau — et l’instance est l’identité : l’outil
n’atteint que ses fichiers.

```ts
import * as files from "../../packages/chest-client/src/files.js";
await files.put("photos/chat.png", octets, "image/png");  // Uint8Array ou texte
const fichier = await files.get("photos/chat.png");        // {data, type, size} ou null
const { files: liste, next } = await files.list({ prefix: "photos/" }); // 1000 par page
await files.delete("photos/chat.png");                     // true, ou false s’il n’existait pas
const { url, expiresIn } = await files.url("photos/chat.png");
```

Un nom : jusqu’à 8 segments de 1 à 100 lettres, chiffres, `.`, `_` ou `-`,
séparés par `/`, aucun commençant par `.` ou `-` ; refusé avant tout envoi
sinon (`ChestError`, `invalid_name`). `url` signe un lien vers le fichier tel
qu’il est, sur l’**hôte d’équipe** de l’outil (`/_chest/files/…`) : qui l’a
l’ouvre sans se connecter pendant 15 minutes, ou jusqu’à ce que le fichier
change ou parte ; le Chest le sert dans un bac à sable, affiché pour une
image, un PDF ou du texte brut, téléchargé sinon. Le donner au navigateur
d’un membre, jamais à une page publique. Erreurs : `CapabilityNotGranted`
(version sans la capacité, ou pas de `CHEST_API`), `TooLarge` (413),
`QuotaExceeded` (429), `Unavailable` (Chest injoignable ou réponse qui n’est
pas la sienne : une écriture a pu avoir lieu ou non), `ChestError` pour le
reste (`invalid_type`, `not_found` pour `url`…). Retirer l’outil retire ses
fichiers ; une nouvelle version les garde.

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

Licence : MIT (`LICENSE`), © 2026 Argentic.
