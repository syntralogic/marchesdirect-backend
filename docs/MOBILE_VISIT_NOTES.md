# Notes de visite HubSpot lisibles sur mobile

Correctif préparé le 1er novembre 2026. Déploiement soumis à l'accord d'Hedi après présentation du texte exact.

## Comportement

- Une visite est une suite d'événements du même navigateur, attribués à la même entreprise, sans interruption de 30 minutes. Le navigateur conserve son identifiant plusieurs jours ; il ne définit donc pas à lui seul une visite.
- Pas de note à la saisie du SIRET ni à l'analyse seule. La première saisie des coordonnées ou le premier choix (rappel, dossier, rendez-vous, simple renseignement) ouvre la note.
- La suite de cette visite met à jour le même identifiant HubSpot. Le titre utilise le choix le plus récent, le dernier score de cette visite et sa source/campagne, lorsqu'ils sont connus.
- Maximum cinq annonces distinctes de cette visite : titre abrégé, département disponible, échéance J-x et lien direct. Une ligne de parcours synthétise les étapes. Aucun appel IA.
- Le résumé de l'entreprise conserve toutes les visites et reste recopié sur les transactions existantes. Les lignes de consultation ou de score sans titre d'annonce sont masquées dans ce résumé ; les événements et scores sources sont conservés.
- Les entreprises de test connues et celles dont `md_is_test=true` dans HubSpot ne génèrent plus de notes ni de transactions. Une erreur de lecture du drapeau bloque la création jusqu'à une nouvelle tentative. Les propriétés de l'entreprise continuent à être actualisées.
- Les notes existantes restent intactes. Les visites antérieures à l'activation et celles possédant déjà une ancienne note ne sont pas converties automatiquement.

## Persistance et reprise

La migration additive crée `journey_visit_notes` et enregistre une date d'activation dans `crm_setup_log`. L'ancienne table `journey_note_outbox` est conservée. La migration est réexécutable.

Le service sérialise les mises à jour locales et réserve chaque note sous verrou transactionnel PostgreSQL avant un POST HubSpot. L'identifiant HubSpot est conservé pour les PATCH suivants ; une relance identique n'écrit rien et une ancienne photographie du parcours ne remplace pas une plus récente.

Si une création a un résultat réseau ambigu, la ligne passe à `needs_review` : aucune nouvelle création aveugle. Une interruption du processus peut laisser `posting`. Dans ces deux cas, contrôler les notes associées à l'entreprise et à la période, puis rattacher l'identifiant trouvé avant reprise. Ne jamais remettre une création incertaine à zéro sans vérifier HubSpot. Les PATCH ayant un identifiant connu sont réessayables.

## Aperçu exact, non publié

Exemple produit à partir de la visite de recette ZIENT LABS du 01/11 à 17h36 (heure de Paris). Cette entreprise étant un test, le service ne publiera pas cette note.

**Rappel demandé · score 25 % · source SMS recette electriciens 33**

Visite du 01/11 17h36 — 01/11 17h37

- [Restauration – conservation sur les œuvres d’art du Musée Jacquemart André (75) · J-39](https://marchesdirect.fr/opportunites/a6a96709-e019-4fc2-94db-d63440a923bf)
- [Sensibilisation au risque inondation par la mise en place de repères de… (09) · J-33](https://marchesdirect.fr/opportunites/1124659a-76d0-4241-bcb7-73e1dfd26dfb)
- [Fourniture de produits chimiques divers de laboratoire pour le Laboratoire… (75) · J-32](https://marchesdirect.fr/opportunites/30e1016b-5ad0-49d7-944a-45b440557cc6)
- [Extension De La Déchetterie De Thones Et Construction D'Un Bâtiment (74) · J-32](https://marchesdirect.fr/opportunites/110aeea5-6d32-467d-bd23-40b12e21e1ab)
- [Réhabilitation des réseaux d'assainissement et du système d'épuration de la… (23) · J-30](https://marchesdirect.fr/opportunites/e425b0cf-adee-46a2-aea9-709a21e9dfcc)

SIRET saisi → analyse 25 % → retour arrière → 2 annonces → coordonnées → rappel

## Validation

- Suite serveur complète : 491 tests réussis, 47 ignorés (54 suites réussies, 6 ignorées).
- Compilation TypeScript réussie.
- Après la dernière correction du filtre du résumé : 9 tests de projection réussis. Après correction de la requête SQL : 9 tests du service de notes réussis.
- `node tests/visit-notes-postgres.cjs` après compilation : migration répétée, création/mise à jour/relance, séparation à 30 minutes et préservation des anciennes notes vérifiées dans PostgreSQL jetable. Aucun appel réel à HubSpot.

## Nettoyage proposé, non exécuté

Neuf notes automatiques de test ont été identifiées sur ZIENT LABS (entreprise 460484274425, portail 149642063), trois par visite :

- 17h36–17h37 : 536972521705, 536975649995, 536926347459.
- 20h38–20h39 : 536980513999, 536980238564, 536924560584.
- 20h43 : 536980172990, 536859558105, 536979955950.

Proposition : sauvegarder puis archiver uniquement ces neuf notes après accord distinct d'Hedi. Aucun nettoyage de notes manuelles ou de transactions. Le résumé et les données sources restent conservés.

## Mise en service

Backend uniquement ; aucun changement de frontend, de texte du site, de design, d'IA ou d'envoi d'e-mails. Après accord de fusion/déploiement : contrôler les logs, la disponibilité, la projection du résumé et l'absence de nouvelles notes/transactions sur une entreprise test. Vérifier le cycle de note non test avec des requêtes simulées, sans transformer ZIENT LABS en prospect réel.
