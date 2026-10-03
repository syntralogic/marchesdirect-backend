import { lotsFromDescription } from './boampLots';
import { extractQualificationsFromText } from './qualificationText';

// ============================================================================
// SOURCE-ONLY FALLBACK FOR THE 3 ANALYSIS ACCORDIONS
//
// 30 Sep audit, point 1: on the five public marchés tested, the fiche stayed on
// "Analyse en cours de génération" and the three accordions never appeared,
// because they only exist once the AI call succeeds (and that call can fail,
// time out or never be reached). Client ask: "afficher immédiatement les
// informations disponibles dans la source et un état clair pour les éléments
// manquants ... sans informations inventées".
//
// This builds {presentation, conditions, entreprises} ONLY from fields already
// stored for the notice - nothing is generated or guessed. Missing elements say
// so explicitly. The buyer name is never used (private notices redact it).
// ============================================================================

export interface SourceSections {
  presentation: string;
  conditions: string;
  entreprises: string;
}

const fmtDate = (d: unknown): string | null => {
  if (!d) return null;
  const date = new Date(d as any);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
};

const fmtMoney = (v: unknown): string | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${Math.round(n).toLocaleString('fr-FR')} €`;
};

const NATURE_LABEL: Record<string, string> = { travaux: 'travaux', fournitures: 'fournitures', etudes: 'études / prestations intellectuelles', mixte: 'prestations mixtes' };

const clean = (s: unknown): string => String(s || '').replace(/\s+/g, ' ').trim();

export function buildSourceAnalysisSections(opp: Record<string, any>): SourceSections {
  const title = clean(opp.title);
  const description = String(opp.description || '');
  const lots = lotsFromDescription(description);
  const body = clean(description.replace(/\n*\s*Lots\s*:[\s\S]*$/, ''));

  // --- Présentation du marché
  const pres: string[] = [];
  if (body && body.toLowerCase() !== title.toLowerCase()) pres.push(body.length > 900 ? `${body.slice(0, 900).replace(/\s+\S*$/, '')}…` : body);
  else if (title) pres.push(title);
  const place = [clean(opp.location_city), clean(opp.location_department) && `(${clean(opp.location_department)})`, clean(opp.location_region)].filter(Boolean).join(' ');
  pres.push(place ? `Lieu d’exécution : ${place}.` : 'Lieu d’exécution : non précisé dans l’annonce.');
  if (lots.length) pres.push(`Lots indiqués dans l’avis :\n${lots.map((l) => `• ${l}`).join('\n')}`);
  else pres.push('Allotissement : aucun lot n’est indiqué dans les données disponibles.');
  const nature = NATURE_LABEL[String(opp.nature_prestation || '')];
  if (nature) pres.push(`Nature de la prestation : ${nature}.`);

  // --- Conditions et points à vérifier
  const cond: string[] = [];
  const deadline = fmtDate(opp.deadline);
  cond.push(deadline ? `Date limite de remise : ${deadline}.` : 'Date limite de remise : non communiquée dans les données disponibles.');
  const value = fmtMoney(opp.estimated_value);
  cond.push(value ? `Montant estimé : ${value}.` : 'Montant estimé : non communiqué.');
  const start = fmtDate(opp.estimated_start_date);
  if (start) cond.push(`Démarrage prévu : ${start}.`);
  const quals = extractQualificationsFromText(description, title);
  cond.push(quals ? `Qualifications mentionnées : ${quals}.` : 'Qualifications exigées : aucune mention dans les données disponibles — à vérifier dans le règlement de consultation.');
  // DEV-03: a mandatory visit must be visible before the visitor applies. Read
  // from the notice text only; absent is "à vérifier", never "no visit".
  const hay = `${title} ${description}`;
  if (/visite[^.\n]{0,80}(facultative|non obligatoire|pas obligatoire)|(non|pas)\s+obligatoire[^.\n]{0,40}visite/i.test(hay)) cond.push('Visite des lieux : non obligatoire selon l’avis.');
  else if (/visite[^.\n]{0,80}obligatoire|obligatoire[^.\n]{0,40}visite/i.test(hay)) cond.push('Visite des lieux : OBLIGATOIRE selon l’avis — à planifier avant de répondre.');
  else cond.push('Visite des lieux : non indiquée dans les données disponibles — à vérifier dans le règlement de consultation.');
  cond.push('Points à vérifier : pièces du dossier de consultation, critères de jugement et conditions de participation, dans l’avis officiel.');

  // --- Entreprises concernées
  const ent: string[] = [];
  if (opp.trade_name) ent.push(`Métier principal : ${clean(opp.trade_name)}.`);
  if (lots.length) ent.push('Entreprises des métiers correspondant aux lots listés ci-dessus.');
  if (!opp.trade_name && !lots.length) ent.push('Le métier recherché n’est pas précisé de façon certaine dans l’annonce : consultez l’avis officiel avant de candidater.');

  return { presentation: pres.join('\n\n'), conditions: cond.join('\n'), entreprises: ent.join('\n') };
}
