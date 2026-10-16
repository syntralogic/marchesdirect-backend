// Part 7 - which data source supplies which requested field, what it costs, and whether it is wired in.
// Static on purpose: this is the documented answer to "which fields need another provider or a
// premium API". The admin UI and docs/PART7_GOOGLE_API_INTEGRATION.md render the same list.
// Nothing marked "not_integrated" is ever filled with estimated data: those fields stay
// "unavailable" in field_meta and in the exports (with the reason).

import { googleReadiness } from './googlePlacesService';

export type ProviderState = 'integrated' | 'integrated_gated' | 'not_integrated' | 'not_possible';

export interface ProviderEntry {
  key: string;
  fields: string[];            // requested fields this source can fill
  provider: string;
  state: ProviderState;        // integrated = free & active; integrated_gated = coded, billed, needs approval switches;
                               // not_integrated = needs a paid contract / key we do not have; not_possible = no authorised source exists
  cost: 'free' | 'paid' | 'n/a';
  needs: string[];             // backend settings / contracts required
  note: string;
}

export const PROVIDERS: ProviderEntry[] = [
  {
    key: 'sirene', provider: 'SIRENE via recherche-entreprises.api.gouv.fr (data.gouv.fr)', state: 'integrated', cost: 'free', needs: [],
    fields: ['Dénomination', 'SIREN / SIRET', 'Adresse', 'Code NAF / activité', 'Forme juridique', 'Date de création / cessation', 'Tranche d’effectif', 'Dirigeants', 'CA et résultat net (si publiés)', 'Certifications RGE / Qualiopi / bio / ESS', 'Coordonnées GPS'],
    note: 'Open data, no key. Revenue, directors and employee range exist only when the company published them (otherwise recorded as confirmed missing).',
  },
  {
    key: 'google_places', provider: 'Google Places API (New) - Text Search', state: 'integrated_gated', cost: 'paid',
    needs: ['GOOGLE_PLACES_API_KEY', 'GOOGLE_PLACES_ENABLED=true', 'GOOGLE_PLACES_DAILY_CAP>0', 'Places API (New) enabled + billing on the Google Cloud project'],
    fields: ['Lien Google Business Profile / Maps', 'Note Google', 'Nombre total d’avis', 'Site web', 'Téléphone'],
    note: 'Link (googleMapsUri) is a lower-priced field; rating, review count, website and phone are Enterprise-level fields. Billed per request by the fields requested: check price and free allowance in the Cloud console.',
  },
  {
    key: 'company_website', provider: 'Company’s own website (home page links)', state: 'integrated', cost: 'free', needs: [],
    fields: ['Page Facebook', 'Instagram', 'LinkedIn', 'Téléphone', 'E-mail professionnel'],
    note: 'Only links the company itself publishes, and only when its website is already known (from Google or the registry). Nothing is guessed from the name.',
  },
  {
    key: 'google_positive_reviews', provider: 'Licensed review-data provider (not Google Places)', state: 'not_integrated', cost: 'paid', needs: ['Provider contract + API key (client choice)'],
    fields: ['Avis Google positifs (nombre)', 'Avis Google positifs (%)'],
    note: 'Places returns the average rating, the total count and a small sample of reviews, never the star distribution, so the positive share cannot be computed reliably. Left "unavailable", never estimated.',
  },
  {
    key: 'google_business_profile_api', provider: 'Google Business Profile APIs (My Business)', state: 'not_possible', cost: 'n/a', needs: [],
    fields: ['Données de fiches tierces'],
    note: 'These APIs only expose locations that the authenticated Google account owns or manages, so they cannot be used to read other businesses’ profiles for prospecting. Places API is the supported route for third-party listings.',
  },
  {
    key: 'pappers', provider: 'Pappers API', state: 'not_integrated', cost: 'paid', needs: ['PAPPERS_API_KEY (already used by the SIRET lookup) + approval for bulk use'],
    fields: ['Chiffre d’affaires / bilans détaillés', 'Historique et événements légaux'],
    note: 'Already used one company at a time by the SIRET lookup, but NOT wired to the prospect database: bulk enrichment is billed per call and needs the client’s approval first.',
  },
  {
    key: 'licensed_contacts', provider: 'Licensed professional directories (e.g. Pages Jaunes / Solocal)', state: 'not_integrated', cost: 'paid', needs: ['Commercial contract + API key'],
    fields: ['Téléphone et e-mail professionnels non publiés sur le site de l’entreprise'],
    note: 'No free authorised source gives professional e-mails at scale. Fields stay empty with status when not found on the company’s own site.',
  },
];

export function providerReport() {
  const g = googleReadiness();
  return PROVIDERS.map(p => p.key === 'google_places'
    ? { ...p, ready: g.ready, readyMessage: g.ready ? `Prêt (plafond ${g.dailyCap}/jour)` : g.message }
    : { ...p, ready: p.state === 'integrated', readyMessage: p.state === 'integrated' ? 'Actif' : p.state === 'not_possible' ? 'Non réalisable' : 'Non intégré' });
}
