# Votre application Chest — exemple du banc d’essai

Ce projet autonome contient le banc d’essai (l’outil de test du dépôt Chest, qui
exerce tout ce qu’un Chest permet), ses tests et le client Chest actuel.
Il ne contient ni le Core, ni de configuration d’entreprise, ni d’accès au VPS.
Ouvrez ce dossier dans votre outil habituel et demandez à votre agent de modifier
le métier. Le SDK est fourni en sources pour cette preuve ; il n’est pas publié
sur npm et ses imports ne constituent pas encore un format définitif.

D’où vient ce projet : le dépôt Chest l’assemble par `scripts/export-creator.mjs`
à partir de trois sources — ce gabarit (dossier `template/` du SDK
`chest-by-argentic/Chest-SDK` : ce README, `AGENTS.md`, `chest.template.json`,
`.containerignore`, `scripts/package.mjs`), le client du SDK (`client/src` et
`client/test`, copiés dans `packages/chest-client`) et l’outil d’exemple
`apps/testapp` du dépôt Chest. Un auteur d’outil part en général d’un projet
exporté ainsi, ou du dépôt `forms` du store (`chest-by-argentic/forms`,
Formulaires), qui suit la même disposition. `packages/chest-client` est une
copie vendue du SDK : on ne la modifie pas dans l’outil, on la remet à jour
depuis le SDK.

## Développer et tester

Avec Node et npm installés :

```sh
npm ci --ignore-scripts
npm test
```

Les versions et empreintes des outils sont verrouillées. Si le cache npm contient
déjà ces versions, ajoutez `--offline` à `npm ci`. La compilation et les tests
n’ont pas besoin de serveur Chest, de compte, de Go ou de Podman.

`apps/testapp/src/model.ts` valide les données, `service.ts` applique le métier,
`invoke.ts` adapte les requêtes et vérifie les droits, `worker.ts` utilise la boucle
SDK. Les opérations des membres sont `state`, `add`, `remove`, `open`, `share`,
`close` et `role` ; celles du visiteur, `public-state` et `public-visit`. Une
révision obsolète reçoit 409 ; une erreur de stockage ne devient jamais un état
vide. Le stockage de cette preuve reste limité à 1 Kio, avec cinq notes de 120
octets UTF-8 chacune. Les membres autorisés partagent le même état.

## Livrer votre code au Chest : la voie simple

Le Chest construit lui-même votre outil depuis ses sources, sans Podman de votre
côté. Ajoutez à la racine du projet un fichier `chest.json` qui nomme l’outil,
ses permissions, ses rôles éventuels et le fichier d’entrée produit par
`npm run build` :

```json
{"name":"testapp","permissions":["record","requests"],"roles":["lecteur","editeur"],"build":{"runtime":"node","entry":"dist/apps/testapp/src/worker.js"}}
```

Puis emballez le projet, sans `node_modules` ni `.git` :

```sh
npm test
tar --exclude node_modules --exclude .git --exclude dist -czf testapp.tar.gz -C . .
```

Le propriétaire envoie `testapp.tar.gz` sur la page Outils, « Construire depuis
le code ». Le Chest vérifie l’archive (32 Mio, `package-lock.json` exigé),
installe les dépendances avec `npm ci`, exécute `npm run build`, retire les
dépendances de développement et construit l’image sur sa propre image Node
épinglée ; votre `Containerfile` et `.containerignore` ne sont pas utilisés. Le
journal de construction est visible sur la page ; une fois « Prête », l’outil
apparaît dans « Ajouter un outil » et s’installe comme n’importe quelle offre.
Six outils construits au plus par Chest, une construction à la fois, dix
minutes chacune. Les deux voies écrivent un `chest.json` : celui de l’ancienne
voie nomme une image, celui-ci nomme une entrée ; n’en gardez qu’un.

## Construire l’image sur votre machine de développement (ancienne voie)

Avec Podman et la base Node épinglée dans `Containerfile` déjà disponible :

```sh
npm test
podman build --pull=never --network=none -f Containerfile --iidfile image.id .
npm run package -- "$(cat image.id)"
podman save --format oci-archive --output testapp.oci "$(cat image.id)"
```

Le contexte de construction contient uniquement le code compilé nécessaire et le
fichier package.json. L’image cible doit correspondre à l’architecture du Chest ;
la preuve actuelle utilise Linux ARM64. Le SDK communique par le canal privé
fourni par Chest : démarrer directement ce worker sans le Core ne fournit aucun
service. N’ajoutez pas de secrets à l’image.

`chest.template.json` porte le nom et les permissions demandées. `chest.json` lie
ces demandes à l’image exacte ; sa préparation refuse d’écraser un fichier
existant. Après une nouvelle construction, conservez ou retirez explicitement
l’ancien package avant de générer le nouveau. L’empreinte affichée n’accorde aucun
droit et ne constitue pas une signature de confiance.

## Livraison : limite actuelle

Dans le portail de votre Chest, le propriétaire choisit `chest.json` dans
« Votre propre application », examine les permissions et confirme l’installation.
L’examen ne démarre rien. Les octets confirmés doivent correspondre au package
examiné ; les droits des membres se règlent ensuite séparément.

Après l’examen, choisissez `testapp.oci` dans « Archive de l’image » puis utilisez
« Transférer et vérifier l’image ». Le transfert ne charge ni ne démarre l’image.
La confirmation d’installation la charge ensuite et démarre le worker. Aucun
accès au VPS ni offre préparée par l’opérateur n’est requis pour ce parcours.

Limites du laboratoire : une archive en attente, 256 Mio transférés et 512 Mio
décompressés maximum. L’archive en attente est perdue au redémarrage ; retransférez
le même fichier si nécessaire. Six identifiants d’image distincts peuvent être
importés par installation, y compris les tentatives interrompues après réservation.
Réessayer le même identifiant ne consomme pas de place supplémentaire. La récupération de cette capacité après abandon reste à développer.
Le format accepté est OCI Linux pour l’architecture du nœud, avec couches tar ou
gzip ; aucun registre distant n’est contacté par ce parcours.

Le propriétaire retrouve le quota utilisé et l’image en attente dans « Transfert
des images », même après rechargement de la page. Il peut retirer cette archive
pour libérer le fichier temporaire. Ce retrait ne supprime pas les applications
et ne restitue pas les places déjà réservées par des imports. Il faut choisir à
nouveau le package et transférer l’archive pour reprendre après ce retrait.

## Votre interface

`apps/testapp/src/view.ts` contient maintenant l’interface de l’application. Le
worker la retourne à un membre autorisé avec l’opération `interface`. Le code
compilé est livré dans la même image que le métier ; il peut donc évoluer sans
recompiler le portail Chest. Modifiez ses textes, sa présentation et ses actions
avec votre agent habituel. Le nom d’application vient de `chest.template.json`.

Le contrat expérimental est un objet `html`, `css`, `script`, limité à 32 Kio
JSON UTF-8. Le script utilise `window.chest.invoke(operation, input)` et reçoit le
résultat métier. Dans cet exemple, une fonction autonome est sérialisée après
compilation TypeScript : elle ne doit capturer aucun import ni variable du worker.
Les ressources réseau, imports navigateur et fontes externes ne sont pas pris
en charge ; utilisez les polices système et un document autonome.

L’interface s’exécute dans un cadre isolé, sans accès aux cookies, au stockage
navigateur ou au DOM du portail. Le pont est lié à l’application ouverte ; chaque
appel subit les autorisations serveur courantes. Le worker reste responsable de
ses règles métier et peut refuser une action. Aucun droit ne vient du script.
Une mutation au résultat incertain ne doit jamais être rejouée automatiquement :
actualisez l’état depuis Chest. Le cadre se ferme en changeant d’application.
Ce cadre n’autorise ni l’envoi natif d’un `<form>`, ni `alert`/`confirm`, ni
l’ouverture d’un lien ou d’une fenêtre : portez l’action sur un bouton et
confirmez dans la page. Chest ajuste la hauteur du cadre à votre document.

Une entrée publique, sans compte, demande la permission `public-requests`,
approuvée avec le package. Le visiteur n’atteint que les opérations nommées
`public-…` : `public-interface` renvoie le document de la page publique, les
autres sont les vôtres. Leur enveloppe est anonyme (sujet vide, aucun droit) :
votre worker décide ce qu’un visiteur peut lire ou écrire. `window.chest.publicEntry`
donne à l’interface des membres l’adresse à partager, ou une chaîne vide sans
cette permission. Les opérations `public-state` et `public-visit` de cet exemple
en sont l’illustration : ouvertes une fois l’espace partagé, 404 sinon.

Limites : sans pièces jointes, ressources externes ni navigation propre. Le
parcours privé est éprouvé sous Chromium et Firefox. L’export modifié hors du
dépôt est aussi installé par le scénario Chromium ; l’essai par une personne
extérieure reste à réaliser. Safari et les appareils mobiles ne sont pas couverts.


Le cadre isolé de cet exemple décrit le mode intégré actuel du laboratoire.
Chest vise aussi des applications ouvertes directement sur leur propre page,
avec des entrées publiques et privées selon leurs usages. Le cadre et l’opération
`interface` ne constituent pas une obligation universelle du contrat futur.
Le laboratoire peut aussi exécuter cette interface sur un hôte applicatif isolé,
dont le domaine est préparé pour le Chest. Lorsque l’enregistrement automatique
est activé, l’installation approuvée crée son client OIDC et raccorde son URL,
sans configuration spécifique au code de l’application. Le même `window.chest.invoke`
est disponible, limité à cette application côté serveur. Ne retirez pas le sandbox
pour servir ce script sous l’origine du portail ; utilisez l’hôte dédié. Les domaines
clients automatiques et les comptes externes ne sont pas encore livrés.
