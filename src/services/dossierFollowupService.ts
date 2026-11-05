import axios, { AxiosRequestConfig } from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { isTestCompany } from './companyProfileService';
import { defaultCommercialOwner, marketTypeOf } from './hubspotDealService';
import { activeCrmSystem } from './crmSystem';

// ============================================================================
// SUIVI DES DOSSIERS (5 nov., demande client : favoris, « Confier à Elena », suivi par étapes)
//
// Une seule source de vérité pour l'avancement : le pipeline HubSpot « Dossiers en cours ». Elena déplace la
// transaction d'une colonne à l'autre ; le site relit l'étape (à la demande, puis toutes les 10 minutes) et la
// traduit en langage client. Aucune double saisie.
//
// Règles :
//  - « Confier à Elena » suppose une demande déjà faite sur ce marché (crm_leads : on a un téléphone pour la joindre).
//  - Entreprise ou demande de test : suivi local seulement, jamais de transaction HubSpot.
//  - La transaction de suivi est séparée de la transaction commerciale (pipeline « Accompagnement ») ; elle reprend
//    les mêmes associations contact / entreprise. Elle ne porte PAS md_request_id (réservé à la transaction commerciale).
// ============================================================================

export const FOLLOWUP_PIPELINE_ID = process.env.HUBSPOT_FOLLOWUP_PIPELINE_ID || '4302995668';
export const FOLLOWUP_STAGES = {
  entrusted: '6368543961',   // Dossier confié
  documents: '6368543962',   // Pièces demandées
  drafting: '6368543963',    // Rédaction en cours
  signature: '6368543964',   // À signer par le client
  filed: '6368543965',       // Déposé
  won: '6368543966',         // Gagné
  lost: '6368543967',        // Non retenu
} as const;
export type FollowupStage = keyof typeof FOLLOWUP_STAGES;
const STAGE_BY_ID: Record<string, FollowupStage> = Object.fromEntries(Object.entries(FOLLOWUP_STAGES).map(([k, v]) => [v, k as FollowupStage]));
export const stageFromHubspot = (id: string | null | undefined): FollowupStage | null => (id && STAGE_BY_ID[String(id)]) || null;

const hubspotOn = () => !!process.env.HUBSPOT_ACCESS_TOKEN && activeCrmSystem() === 'hubspot';
async function hs<T = any>(cfg: AxiosRequestConfig): Promise<T> {
  const res = await axios.request({
    baseURL: (process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com').replace(/\/$/, ''), timeout: 10000, ...cfg,
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...(cfg.headers || {}) },
  });
  return res.data as T;
}

export async function ensureFollowupSchema(): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS dossier_followups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lead_id UUID NOT NULL UNIQUE,
    opportunity_id UUID NOT NULL,
    session_id VARCHAR(100),
    siret VARCHAR(14),
    email VARCHAR(255),
    company_id UUID,
    hubspot_deal_id VARCHAR(40),
    stage VARCHAR(20) NOT NULL DEFAULT 'entrusted',
    stage_history JSONB NOT NULL DEFAULT '[]',
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    hubspot_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS dossier_followups_session ON dossier_followups(session_id)');
  await db.query('CREATE INDEX IF NOT EXISTS dossier_followups_email ON dossier_followups(lower(email))');
  await db.query('CREATE INDEX IF NOT EXISTS dossier_followups_company ON dossier_followups(company_id)');
}
let schemaReady: Promise<void> | null = null;
export const followupSchema = () => (schemaReady ??= ensureFollowupSchema().catch(e => { schemaReady = null; throw e; }));

/** Dernière demande (téléphone connu) de cette session sur ce marché. */
export async function findLeadFor(sessionIds: string[], opportunityId: string, email?: string | null) {
  const r = await db.query(
    `SELECT l.id, l.session_id, l.siret, l.email, l.phone, l.company_name, l.is_test, l.created_at, d.hubspot_deal_id
       FROM crm_leads l LEFT JOIN crm_deals d ON d.lead_id = l.id
      WHERE l.opportunity_id = $1 AND (l.session_id = ANY($2) OR ($3::text IS NOT NULL AND lower(l.email) = lower($3)))
      ORDER BY l.created_at DESC LIMIT 1`, [opportunityId, sessionIds, email || null]);
  return r.rows[0] || null;
}

async function createFollowupDeal(lead: any, followupId: string): Promise<string | null> {
  const o = await db.query(
    `SELECT o.title, o.deadline, o.source_reference, o.official_url, ot.code AS journey
       FROM opportunities o LEFT JOIN opportunity_types ot ON ot.id = o.opportunity_type_id WHERE o.id = $1`, [lead.opportunity_id]);
  const m = o.rows[0] || {};
  const label = lead.company_name || lead.email || 'Entreprise';
  const created = await hs<{ id: string }>({ method: 'POST', url: '/crm/v3/objects/deals', data: { properties: {
    dealname: `Dossier confié - ${label} - ${m.title || 'Marché'}`.slice(0, 250),
    pipeline: FOLLOWUP_PIPELINE_ID, dealstage: FOLLOWUP_STAGES.entrusted, hubspot_owner_id: defaultCommercialOwner(),
    closedate: m.deadline ? new Date(m.deadline).toISOString() : undefined,
    md_market_type: marketTypeOf(m.journey) || undefined,
    md_market_reference: m.source_reference ? String(m.source_reference).slice(0, 255) : undefined,
    md_market_url: m.official_url || undefined,
    description: `Dossier confié à Elena depuis le site le ${new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })}. Téléphone : ${lead.phone || 'non communiqué'}. Suivi n° ${followupId}.`,
  } } });
  const dealId = String(created.id);
  // Mêmes contact et entreprise que la transaction commerciale de cette demande.
  if (lead.hubspot_deal_id) {
    for (const to of ['contacts', 'companies']) {
      try {
        const a = await hs<{ results?: { toObjectId: number | string }[] }>({ method: 'GET', url: `/crm/v4/objects/deals/${lead.hubspot_deal_id}/associations/${to}` });
        for (const x of a.results || []) await hs({ method: 'PUT', url: `/crm/v4/objects/deals/${dealId}/associations/default/${to}/${x.toObjectId}` });
      } catch (e: any) { logger.warn(`[Suivi] association ${to} impossible: ${e?.message}`); }
    }
  }
  return dealId;
}

/** « Confier à Elena » : idempotent (un suivi par demande). */
export async function entrustDossier(args: { sessionIds: string[]; opportunityId: string; email?: string | null; companyId?: string | null }) {
  await followupSchema();
  const lead = await findLeadFor(args.sessionIds, args.opportunityId, args.email);
  if (!lead) return { ok: false as const, code: 'lead_required' };
  const test = !!lead.is_test || isTestCompany(lead.siret || '', lead.company_name);
  const ins = await db.query(
    `INSERT INTO dossier_followups (lead_id, opportunity_id, session_id, siret, email, company_id, is_test, stage_history)
     VALUES ($1, $2, $3, $4, $5, $6, $7, jsonb_build_array(jsonb_build_object('stage','entrusted','at',NOW())))
     ON CONFLICT (lead_id) DO UPDATE SET company_id = COALESCE(dossier_followups.company_id, EXCLUDED.company_id), updated_at = NOW()
     RETURNING *, (xmax = 0) AS inserted`,
    [lead.id, args.opportunityId, lead.session_id, lead.siret, lead.email, args.companyId || null, test]);
  const row = ins.rows[0];
  if (!row.hubspot_deal_id && !test && hubspotOn()) {
    try {
      const dealId = await createFollowupDeal({ ...lead, opportunity_id: args.opportunityId }, row.id);
      await db.query('UPDATE dossier_followups SET hubspot_deal_id = $2, synced_at = NOW(), hubspot_error = NULL WHERE id = $1', [row.id, dealId]);
      row.hubspot_deal_id = dealId;
    } catch (e: any) {
      logger.error('[Suivi] création de la transaction HubSpot impossible:', e?.response?.data || e?.message);
      await db.query('UPDATE dossier_followups SET hubspot_error = $2 WHERE id = $1', [row.id, String(e?.message || 'error').slice(0, 300)]);
    }
  }
  if (lead.session_id) try {
    await db.query(`INSERT INTO visitor_events (session_id, event_type, event_label, opportunity_id, siret) VALUES ($1, 'dossier_entrusted', 'Dossier confié à Elena', $2, $3)`,
      [lead.session_id, args.opportunityId, lead.siret]);
  } catch { /* parcours : non bloquant */ }
  return { ok: true as const, followup: row };
}

/** Relit l'étape HubSpot des suivis donnés (lot de 100). Ne recule jamais l'historique, ajoute chaque nouvelle étape. */
export async function refreshStages(rows: { id: string; hubspot_deal_id: string | null; stage: string }[]): Promise<number> {
  if (!hubspotOn()) return 0;
  const withDeal = rows.filter(r => r.hubspot_deal_id);
  let changed = 0;
  for (let i = 0; i < withDeal.length; i += 100) {
    const part = withDeal.slice(i, i + 100);
    const batch = await hs<{ results?: { id: string; properties?: { dealstage?: string } }[] }>({ method: 'POST', url: '/crm/v3/objects/deals/batch/read',
      data: { properties: ['dealstage'], inputs: part.map(r => ({ id: r.hubspot_deal_id })) } });
    const byDeal = new Map((batch.results || []).map(d => [String(d.id), stageFromHubspot(d.properties?.dealstage)]));
    for (const r of part) {
      const st = byDeal.get(String(r.hubspot_deal_id));
      if (st && st !== r.stage) {
        await db.query(`UPDATE dossier_followups SET stage = $2, stage_changed_at = NOW(), synced_at = NOW(), updated_at = NOW(),
                          stage_history = stage_history || jsonb_build_array(jsonb_build_object('stage', $2::text, 'at', NOW())) WHERE id = $1`, [r.id, st]);
        r.stage = st; changed++;
      } else {
        await db.query('UPDATE dossier_followups SET synced_at = NOW() WHERE id = $1', [r.id]);
      }
    }
  }
  return changed;
}

/** Tâche de fond : suivis ouverts, ou clos depuis moins de 30 jours. */
export async function refreshOpenFollowups(): Promise<number> {
  await followupSchema();
  const r = await db.query(`SELECT id, hubspot_deal_id, stage FROM dossier_followups
    WHERE hubspot_deal_id IS NOT NULL AND (stage NOT IN ('won','lost') OR stage_changed_at > NOW() - INTERVAL '30 days') ORDER BY synced_at NULLS FIRST LIMIT 500`);
  return refreshStages(r.rows);
}

// ---------------------------------------------------------------- lecture côté client
export type ClientStep = { key: string; label: string; detail: string; state: 'done' | 'current' | 'action' | 'todo'; at: string | null };

const STEP_ORDER: FollowupStage[] = ['entrusted', 'documents', 'drafting', 'signature', 'filed'];
/** Traduit l'étape HubSpot en frise client (6 étapes). Fonction pure, testée. */
export function clientSteps(f: { known: boolean; analysed: boolean; leadAt: string | null; followup: { stage: FollowupStage; created_at: string; stage_history: { stage: string; at: string }[] } | null }): ClientStep[] {
  const at = (s: string) => f.followup?.stage_history?.slice().reverse().find(h => h.stage === s)?.at || null;
  const cur = f.followup?.stage || null;
  const rank = cur ? (cur === 'won' || cur === 'lost' ? 5 : STEP_ORDER.indexOf(cur)) : -1;
  const steps: ClientStep[] = [
    { key: 'company', label: 'Entreprise reconnue', detail: 'Votre entreprise est identifiée', state: f.known ? 'done' : 'current', at: null },
    { key: 'analysis', label: 'Marché analysé', detail: 'Correspondance calculée pour votre entreprise', state: f.analysed ? 'done' : f.known ? 'current' : 'todo', at: null },
    { key: 'dossier', label: 'Votre dossier prérempli', detail: f.leadAt ? 'Dossier prérempli reçu' : 'À votre nom, prêt en un clic, avec un appel d’Elena', state: f.leadAt ? 'done' : f.analysed ? 'current' : 'todo', at: f.leadAt },
  ];
  const entrusted: ClientStep = { key: 'entrusted', label: 'Dossier confié à Elena', detail: 'Elle prépare les pièces et le mémoire technique avec vous', state: 'todo', at: f.followup?.created_at || null };
  if (cur) {
    entrusted.state = rank > 2 ? 'done' : 'current';
    if (cur === 'entrusted') entrusted.detail = 'Elena a bien reçu votre dossier et vous contacte';
    if (cur === 'documents') { entrusted.state = 'action'; entrusted.label = 'Pièces à fournir'; entrusted.detail = 'Elena vous a indiqué les pièces à réunir'; entrusted.at = at('documents'); }
    if (cur === 'drafting') { entrusted.label = 'Rédaction en cours'; entrusted.detail = 'Elena rédige les formulaires et le mémoire technique'; entrusted.at = at('drafting'); }
    if (rank > 2) { entrusted.label = 'Dossier préparé'; entrusted.detail = 'Pièces réunies, mémoire technique rédigé'; entrusted.at = at('drafting') || at('documents') || f.followup!.created_at; }
  } else if (f.leadAt) entrusted.state = 'current';
  const sign: ClientStep = { key: 'signature', label: 'Signature et dépôt', detail: 'Vous signez en ligne, nous déposons avant la date limite', state: 'todo', at: null };
  if (cur === 'signature') { sign.state = 'action'; sign.label = 'À signer par vous'; sign.detail = 'Elena vous envoie le lien de signature électronique'; sign.at = at('signature'); }
  if (rank >= 4) { sign.state = 'done'; sign.label = 'Déposé'; sign.detail = 'Votre candidature a été déposée'; sign.at = at('filed'); }
  const result: ClientStep = { key: 'result', label: 'Résultat', detail: 'Vous êtes prévenu dès la réponse de l’acheteur', state: 'todo', at: null };
  if (cur === 'filed') result.state = 'current';
  if (cur === 'won') { result.state = 'done'; result.label = 'Marché remporté'; result.detail = 'Félicitations : l’acheteur a retenu votre offre'; result.at = at('won'); }
  if (cur === 'lost') { result.state = 'done'; result.label = 'Offre non retenue'; result.detail = 'Elena vous aide à demander les motifs et à préparer le prochain'; result.at = at('lost'); }
  return [...steps, entrusted, sign, result];
}
