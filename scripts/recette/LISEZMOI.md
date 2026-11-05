# Recette recherche v2 (6 nov.)

Rejoue les scénarios de recette sur le vrai code compilé et le vrai SQL, avec un Postgres local.

1. `npx tsc -p tsconfig.json --outDir scripts/recette/out` (ou le build habituel, puis `RECETTE_OUT=../../dist/`).
2. Postgres 16 local sur le socket `/var/tmp/mdpg`, port 5544, base `md`, extensions `unaccent` et `pg_trgm`, puis `psql -f schema.sql`.
3. `node scripts/recette/seed.js` : 100 avis BOAMP réels de Gironde (`avis-gironde.json`, extraits de l'API BOAMP le 5 nov. 2026) et 6 cas marqués TEST.
4. `node -e "require('./scripts/recette/boot.js');require('./scripts/recette/out/jobs/noticeLocationJob.js').runLocationBackfill()"`
5. `node scripts/recette/scenarios.js` : tableau entrée / attendu / obtenu / conclusion ; `node scripts/recette/ba.js` : avant / après.

`boot.js` remplace le module `pg` par un appel à `psql`. Il sert uniquement à la recette locale, jamais en production.
