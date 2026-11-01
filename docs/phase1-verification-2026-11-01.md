# Phase 1 — résultats vérifiés dans la nouvelle conversation, 01/11/2026

## État et périmètre

- Production indiquée par Hedi : Marche-direct-back, offre payante 0,5 CPU / 512 Mo, 7 USD/mois, commit 35425a4. Aucun déploiement effectué pendant cette phase.
- Resend entièrement en pause : aucune clé créée, aucune variable Render ajoutée, aucun e-mail réel envoyé.
- Backend testé : 1ad39607a58cc7ade2683fb511d2ffd603eab3c6 (branche fix/crm-prerequisites-20261101). Les 230 fichiers source exportés ont été vérifiés par leur SHA Git ; aucun écart.
- Frontend : syntralogic/MarchesDirect à 2e6af5834a227da9f5bf1ab99c0ccdbc77a5b588, avec integrations/frontend/reliable-journey.patch appliqué localement. Aucun push frontend.

## Résultats réellement obtenus

| Contrôle | Résultat |
|---|---|
| Compilation backend TypeScript sous Node 22.23.4 | Réussie |
| Suite Jest backend sous Node 22.23.4, --runInBand | 449 tests réussis ; 47 ignorés ; 0 échec ; 49 suites réussies, 6 ignorées |
| Scénario PostgreSQL éphémère PGlite sous Node 22 | Réussi : migration répétée, attribution pré-SIRET, A → B → A, reprise différée, demande immuable, rollback, effacement des coordonnées lors du changement |
| git apply --check du patch frontend | Réussi |
| Build frontend Vite | Réussi, avertissement de taille des bundles |
| Vérification frontend tsgo -p tsconfig.check.json | Réussie |
| node --test tests/reliableEventQueue.test.cjs | 5 réussis, 0 échec, 0 ignoré |

Les cinq tests frontend couvrent la reprise d’un 503 avec SIRET/id/heure d’origine, la récupération après rechargement, le refus de traiter une page HTTP 200 comme un acquittement, le retrait du consentement et l’arrêt des reprises sur un 400.

Le frontend ne définit pas de script npm test général. Les scripts de lint du dépôt référencent des fichiers .rules absents ; le build, le contrôle TypeScript et les tests fournis dans le patch ont été exécutés directement. Le navigateur de production et les workflows HubSpot ne sont pas certifiés par ces tests.

Les 47 tests ignorés nécessitent TEST_DATABASE_URL et un PostgreSQL serveur isolé. Aucun serveur local n’est disponible ; une tentative d’installation a échoué faute de permissions système. Le scénario PGlite réussi ne remplace pas ces 47 tests. Aucune base de production n’a été utilisée pour les tests.

## HubSpot — trois transactions VERIFRANCE

Les trois transactions ont été lues et identifiées. md_is_test est vide et md_dossier_status vaut error :
- 534870120667 — Ventilation de cuisine professionnelle, école privée à Nice
- 534645632212 — Foyer rural de Beaurieux
- 534863065276 — Foyer rural de Beaurieux

La valeur existante de la propriété booléenne est true (libellé actuel True ; futur libellé français Oui à traiter dans la phase 3).
Le marquage demandé a été rejeté par la validation automatique du connecteur, faute de confirmation des lignes exactes dans un tableau. Aucune transaction modifiée. Ne pas confondre tentative et succès ; nouvelle confirmation requise avant reprise.

## AIS ELEC BORDEAUX

Lecture réelle de l’Entreprise HubSpot 460395804909 : SIRET 83438617900024, md_visitors_count=34, md_offer_views_count=0.
Le SQL de scripts/diagnoseJourneyAttribution.sql n’a pas été exécuté sur la base du site. Le connecteur Render ne permet de requêter que des bases hébergées chez Render ; la base du site est Supabase. Le plugin Supabase avec execute_sql a été trouvé et proposé, mais sa connexion n’est pas confirmée.
La cause réelle reste non établie. Les compteurs CRM seuls ne permettent pas de départager absence de consentement, échecs de stockage, identifiants de session et défaut d’attribution.

## Proposition de déploiement backend — accord requis

Cette PR ajoute :
- masquage global des journaux et suppression des contenus de messagerie, coordonnées, liens et secrets dans les logs concernés ;
- POST /api/visitor-events : 204 après transaction validée ou doublon, 400 pour charge invalide, 503 avec Retry-After en cas d’échec du stockage ;
- sélection d’entreprise et journalisation atomiques ; conservation du SIRET brut de l’événement et attribution séparée des premiers événements anonymes ;
- demandes figées au SIRET d’origine, reprise CRM durable, absence de recopie des coordonnées d’une entreprise à l’autre ;
- tables/colonnes additives (sélections, file CRM, attribution, génération de dossier) ; séparation génération/envoi préparée sans activer Resend.

La migration réamorce les sélections à partir de preuves datées existantes ; elle ne réécrit pas en masse le SIRET brut des événements historiques.
Les retries CRM n’appellent pas l’envoi de dossiers. Aucune commande de renvoi des cinq anciens dossiers.
Le drapeau HUBSPOT_DELIVERY_STATUSES_ENABLED reste désactivé tant que les propriétés et le workflow n’ont pas été validés.

Ordre : backend autorisé puis frontend autorisé séparément. Retour arrière : version applicative précédente, conservation des tables/colonnes ajoutées. Avant accord définitif : terminer le diagnostic SQL, le marquage des trois tests et la vérification de l’état Render. Le workspace Render actif n’est pas sélectionné dans cette session ; unique workspace listé : My Workspace (hedifathallahofficiel@gmail.com), confirmation attendue avant lecture des ressources.

## Message à Syntric (brouillon, non envoyé)

Bonjour,

Le correctif frontend de fiabilisation du suivi est disponible ici :
https://github.com/hedi4060/Marche-direct-back/blob/fix/crm-prerequisites-20261101/integrations/frontend/reliable-journey.patch

Il est basé sur le commit 2e6af5834a227da9f5bf1ab99c0ccdbc77a5b588 de syntralogic/MarchesDirect. Il ajoute une file de reprise persistante sous consentement et conserve le SIRET, l’identifiant et l’heure de chaque événement malgré un changement d’entreprise. Seul un HTTP 204 acquitte l’événement ; les erreurs temporaires sont reprises.

Les quatre fichiers concernés sont src/contexts/CompanyKnownContext.tsx, src/lib/visitorTracking.ts, src/lib/reliableEventQueue.ts et tests/reliableEventQueue.test.cjs.

Sur une branche dédiée, vérifier puis appliquer avec git apply --check et git apply. Rejouer le build, le contrôle TypeScript et node --test tests/reliableEventQueue.test.cjs. Ces contrôles viennent de réussir localement sur la base indiquée.

Merci de préparer une PR sans déploiement automatique. L’intégration doit suivre le backend corrigé et chaque déploiement nécessite l’accord explicite de Hedi. Reporter aussi les corrections dans le dépôt amont pour que les synchronisations ne les écrasent pas.

Revue backend : https://github.com/hedi4060/Marche-direct-back/pull/3
