# Application Chest — instructions pour l’agent du créateur

Développer le produit dans `apps/testapp/src` ; les tests sont dans `apps/testapp/test`.
Le client actuel est fourni dans `packages/chest-client` : une copie vendue du
SDK `chest-by-argentic/Chest-SDK` (son dossier `client/src`), à ne pas modifier
ici — un changement du client se fait dans le SDK, puis la copie est remise à
jour. Son contrat est expérimental ; ne pas inventer de capacités ni de
permissions supplémentaires. Ce projet a été assemblé par
`tests/export/export-creator.mjs` du dépôt Chest à partir du gabarit du SDK
(`template/`), de son client et de l’outil d’exemple `apps/testapp`.

- Séparer modèle, logique métier, adaptation des requêtes et stockage.
- Réutiliser le client fourni ; ne pas recopier son protocole dans l’application.
- Aucun code mort, dépendance inutile ou secret dans le projet ou l’image.
- Valider les entrées, l’état persistant et les révisions avant chaque écriture.
- Les droits proviennent uniquement de l’enveloppe transmise par Chest. Un champ
  métier ne peut jamais accorder un droit. Garder le refus des requêtes expirées,
  anonymes ou sans accès avant toute lecture des données.
- Ne jamais rejouer automatiquement une écriture au résultat incertain.
- Ne pas ouvrir de serveur HTTP, de socket vers l’hôte ou de sortie réseau pour
  contourner le canal fourni. La VM cliente et ses identifiants ne sont pas requis.
- Exécuter `npm test` après modification et maintenir les tests de refus.
- Les permissions du manifeste sont des demandes : aucune approbation n’est
  déduite du code, des imports ou de la réussite des tests.

Lire README.md pour les limites du stockage, de l’interface et de la livraison.

L’interface appartient à l’application : `apps/testapp/src/view.ts` renvoie un objet
`html`, `css`, `script` via l’opération privée `interface`. Chest exécute ce code
dans un cadre isolé et fournit `window.chest.invoke(operation, input)`, limité à
cette application. Ne pas utiliser le DOM du portail, ses cookies, son stockage
navigateur, des URLs d’API ou des ressources réseau. Le code navigateur doit être
autonome ; conserver les refus de droits dans le worker et ne pas rejouer une
mutation incertaine. Voir les limites actuelles dans README.md.


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
