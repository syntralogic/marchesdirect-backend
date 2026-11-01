# Prérequis Marchés Direct — proposition de mise en production

État : corrections préparées et testées, pas déployées. Aucun ancien dossier renvoyé. Accord de Hedi requis avant chaque déploiement.

## A. Resend et deux états distincts

À faire par Hedi (accès au compte et au DNS nécessaires) :
1. Créer/ouvrir le compte sur https://resend.com et ajouter le domaine `notifications.marchesdirect.fr` (sous-domaine d’envoi dédié).
2. Dans le gestionnaire DNS du domaine `marchesdirect.fr`, recopier EXACTEMENT les noms, types, valeurs et priorités affichés par Resend : DKIM et SPF/Return-Path (TXT/MX ou les enregistrements proposés). Ne pas remplacer les MX de réception du domaine principal. Les valeurs cryptographiques exactes sont générées par Resend, elles ne sont pas inventables avant création du domaine.
3. Cliquer Verify DNS et attendre Verified. Choisir un emplacement européen si proposé. Configurer aussi DMARC selon la configuration existante du domaine, sans créer deux enregistrements concurrents.
4. Dans API Keys, créer une clé `MarchesDirect-production`, permission Sending access, limitée au domaine vérifié. Copier la clé uniquement dans Render, jamais dans le chat, GitHub ou le navigateur du site.
5. Render > Marche-direct-back > Environment > Edit / Add variable :
   - `RESEND_API_KEY` = la clé secrète générée par Resend.
   - `EMAIL_FROM` = `Marchés Direct <dossiers@notifications.marchesdirect.fr>`.
   Choisir **Save only**. Ne pas cliquer Save and deploy / Save, rebuild, and deploy avant accord.
6. Ne pas activer les campagnes/relances (`FOLLOW_UP_EMAILS_ENABLED`) à cette occasion. L’activation de la clé rend aussi disponibles les autres e-mails déjà prévus par l’application (authentification et notifications internes notamment) : vérifier les interrupteurs existants avant déploiement.

Le code nécessite maintenant clé ET expéditeur explicites ; l’expéditeur de test `@resend.dev` est refusé en production. Un succès signifie « accepté par Resend », pas « arrivé dans la boîte de réception ». Aucun webhook de bounce n’a été ajouté dans ce lot.

`dossier_generations` journalise la génération indépendamment de `message_deliveries`. Une génération réussie reste `md_dossier_status=available` même avec `md_email_status=failed/not_configured`. Les lectures et reprises CRM n’appellent jamais l’envoi des dossiers.

Les cinq dossiers historiques restent en attente de décision (horaires Europe/Paris, 31/10/2026) :

| Transaction HubSpot | Entreprise / annonce | Heure | Test |
|---|---|---|---|
| 534870120667 | VERIFRANCE HABITAT — Ventilation de cuisine professionnelle, école privée Nice | 11h49 | Non identifié comme test |
| 534645632212 | VERIFRANCE HABITAT — Foyer rural Beaurieux | 12h04 | Non identifié comme test |
| 534863065276 | VERIFRANCE HABITAT — Foyer rural Beaurieux | 14h54 | Non identifié comme test |
| 534670938299 | TEST — NE PAS APPELER — Dossier puis rappel — Climatisation Labège | 19h26 | Oui |
| 534769524971 | TEST — NE PAS APPELER — Validation serveur dossier | 21h19 | Oui |

Cause relevée à l’audit : absence de prestataire d’envoi configuré. Une requalification CRM en « PDF généré / envoi non configuré » n’est pas un nouvel envoi. Le lot n’inclut aucune commande de reprise des e-mails historiques.

## B. Journaux

Suppression des corps, objets, destinataires et réponses complètes du prestataire dans les logs de messagerie. Filtre global pour coordonnées, secrets, liens et métadonnées d’erreurs imbriquées. Le journal HTTP garde méthode, route, statut et durée ; il ne conserve plus IP, query string ou Referer. Les journaux anciens ne sont ni purgés ni prétendument nettoyés rétroactivement.

## C. Render

Service observé : Free, Oregon, Node ; auto-déploiement sur `main`. Ne pas fusionner cette branche sans accord.

Free : veille après 15 minutes sans trafic entrant, réveil environ une minute, redémarrages possibles, fichiers locaux éphémères. La veille n’efface pas la base externe, mais un appel échoué sans reprise peut manquer. Les tâches node-cron dans le processus ne tournent pas pendant la veille. Un rattrapage durable reste nécessaire même sur une offre payante.

Minimum pour supprimer la veille : instance Web 0.5 CPU / 512 MB, ancien nom Starter, **7 USD/mois** (hors taxes/extra consommation). Ce minimum n’est pas une garantie de capacité pour tous les imports et traitements PDF ; surveiller RAM et CPU, augmenter si nécessaire. Le plan payant du workspace ne remplace pas le plan de calcul du service.

Tâches à heure fixe indépendantes du serveur Web : Cron Job Render séparé, **minimum 1 USD/mois par cron**, à préparer si nécessaire. Les horaires Render sont en UTC ; le 8h Europe/Paris doit gérer le changement d’heure. Aucun achat/upgrade effectué.

Sources consultées le 01/11/2026 : https://render.com/docs/free ; https://render.com/pricing ; https://render.com/docs/compute-plans ; https://render.com/docs/cronjobs ; https://render.com/docs/configure-environment-variables ; https://resend.com/docs/add-a-domain.

## D. Événements

- 204 seulement après transaction PostgreSQL validée (ou doublon déjà enregistré).
- 503 et Retry-After en cas d’échec, 400 pour un événement invalide.
- File persistante navigateur sous consentement, identifiant/heure/SIRET figés ; reprise exponentielle, au rechargement et au retour réseau.
- File bornée à 200 événements, 24 heures ; sans stockage disponible, reprise mémoire seulement. Fermer définitivement le navigateur, vider son stockage, retirer le consentement ou dépasser ces bornes peut empêcher une reprise : pas de promesse « zéro perte » absolue.
- La synchronisation Entreprise bénéficie d’une file durable et versionnée côté serveur ; ses reprises ne renvoient pas d’e-mail.

## E. SIRET

Le SIRET présent dans l’événement est conservé. L’attribution des événements anonymes initiaux au premier SIRET est séparée de cette valeur brute. Le passage A → B → A ne réattribue pas le passé. L’entreprise HubSpot est calculée sur les événements de son SIRET, pas sur toutes les actions d’un navigateur ayant un jour sélectionné l’entreprise. Une demande garde son SIRET d’origine ; les coordonnées de A ne sont pas recopiées dans B lors du changement.

Historique : seules les sélections datées effectivement présentes servent à amorcer la table ; les événements anciens ne sont pas réécrits en masse. Les données ambiguës ne sont pas inventées.

AIS ELEC BORDEAUX, SIRET 83438617900024, HubSpot 460395804909 : compteurs 34 visiteurs / 0 consultation confirmés. Le défaut de réattribution existe, MAIS il ne prouve pas la cause de ces compteurs. « Visiteurs » compte des identifiants de session, pas nécessairement 34 personnes. Les événements absents (consentement, panne de stockage, variation d’identifiant sans stockage) constituent aussi des hypothèses. Le diagnostic SQL en lecture seule doit être exécuté sur la base réelle avant de conclure ; aucun accès direct à cette base disponible pendant cette préparation.

## Étape 1 — alerte de dossier préparée, non activée

Trois propriétés Transaction à créer après validation via `scripts/ensureHubspotDeliveryProperties.ts --apply` (dry-run sans cet argument) :

| Nom interne | Libellé | Type |
|---|---|---|
| md_email_status | MD — État de l’e-mail du dossier | Liste |
| md_last_delivery_error_at | MD — Date de la dernière erreur de dossier | Date et heure |
| md_delivery_error_code | MD — Cause de l’erreur de dossier | Texte |

Workflow proposé : **MD — Nouvelle erreur de dossier** (Transactions).
- Activation seulement après accord et création des propriétés.
- Déclenchement lorsque `md_last_delivery_error_at` prend une nouvelle valeur ; réinscription sur changement de cette date.
- Filtre `md_is_test` différent de oui ; état `md_dossier_status=error` OU `md_email_status` dans `failed/not_configured`.
- Ne pas inscrire les transactions existantes lors de l’activation. Les lignes historiques sans nouvelle génération n’acquièrent pas de nouvelle date d’erreur dans le code.
- Actions HubSpot natives : notification interne par e-mail + notification dans l’application à Hedi Fathallah (utilisateur 102050175). Message : « Erreur de dossier — [nom transaction]. Génération : [état du dossier]. E-mail : [état e-mail]. Cause : [code]. Ouvrir la transaction. Aucun renvoi automatique effectué. »
- Activer la réception des notifications de workflows pour cet utilisateur et les notifications push HubSpot dans les réglages du téléphone. La remise mobile doit être vérifiée sur un test contrôlé, pas supposée.
- Les notifications natives évitent de dépendre de Resend pour signaler une panne de Resend. Si HubSpot lui-même est indisponible, notification retardée jusqu’à la reprise CRM ; pas d’alerte indépendante de HubSpot dans ce lot.
- Une fois schémas et workflow vérifiés, activer `HUBSPOT_DELIVERY_STATUSES_ENABLED=true` avec le déploiement autorisé. Sans ce drapeau, les nouvelles propriétés ne sont pas envoyées et ne cassent pas les synchronisations existantes.

Le connecteur CRM est opérationnel ; la session navigateur dédiée affiche « authentification expirée ». Il ne permet donc pas actuellement de configurer le workflow. L’alerte mobile n’a pas été activée ni annoncée comme testée.

## Ordre et contrôle de livraison

1. Vérifier Resend et préparer ses variables avec Save only ; vérifier les autres interrupteurs d’envoi.
2. Approuver schémas, configurer le workflow et vérifier les notifications utilisateur.
3. Autoriser explicitement le déploiement backend : migration additive + correction logs/statuts/ingestion/attribution. Sauvegarde habituelle de la base avant migration. Vérifier que `main` et la version Render sont toujours ceux audités ; relire les écarts s’ils ont bougé.
4. Déployer le frontend dans un second accord : file de reprise + SIRET figé. Déployer le backend d’abord, car l’ancien backend renvoie 204 même en cas d’erreur.
5. Tester en préproduction avec des données de test, puis contrôle de production autorisé : 503/204, A/B, dossier généré/échec e-mail, aucune reprise des cinq anciens dossiers, notification e-mail et mobile.

Frontend : patch exact joint dans `integrations/frontend/reliable-journey.patch`, basé sur `syntralogic/MarchesDirect` commit `2e6af5834a227da9f5bf1ab99c0ccdbc77a5b588`. Le compte connecté n’a que la lecture sur ce dépôt ; aucun push frontend effectué. Le développeur peut appliquer le patch sur une branche (`git apply --check` puis `git apply`) et créer sa PR. Les workflows de synchronisation backend ont une fusion automatique depuis Syntric ; reporter les corrections dans le dépôt amont pour éviter une divergence future.

Rollback : restaurer les commits applicatifs précédents, désactiver le drapeau des nouvelles propriétés et le nouveau workflow. Garder les nouvelles tables/colonnes (additives), ne pas effacer les journaux ou les événements.

Validation locale : compilation TypeScript serveur, suite Jest, build Vite et vérification TypeScript frontend, tests de reprise navigateur, scénario PostgreSQL éphémère avec migration répétée et rollback. Aucun e-mail réel envoyé pendant ces tests.
