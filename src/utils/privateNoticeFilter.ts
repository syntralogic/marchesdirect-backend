/**
 * Part 5 (private tenders / subcontracting quality) - decides whether a
 * news-style source item (Batiweb RSS) is a genuine open private tender or
 * subcontracting request, instead of any article that happens to contain the
 * word "marché".
 *
 * The previous filter (/marché|appel d.offres|consultation|avis de|attribu/)
 * let through market-trend articles ("le marché de l'immobilier"), and
 * contract-award news ("attribué à...", "remporte...") - neither is something
 * a visitor can still respond to. It also filed everything as 'tender', so
 * sous-traitance requests never reached the Sous-traitance journey.
 *
 * Nothing here invents data: it only classifies text the source really
 * published, and a notice that doesn't clearly qualify is skipped.
 */

export type PrivateNoticeKind = 'tender' | 'subcontracting' | 'skip';

const strip = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Already-awarded / past-event / market-commentary wording: not open to bids.
const NOT_OPEN = /\b(attribu\w*|laureat\w*|remport\w*|a ete retenu\w*|retenu pour|inaugur\w*|livraison de|mise en service|resultats? de l'appel|palmares|baromètre|barometre|etude de marche|tendances? du marche|marche (de l'immobilier|immobilier|du travail|mondial|francais de))\b/;

// A real call to respond to.
const SUBCONTRACT = /\b(sous-?traitan\w*|co-?traitan\w*|recherche (de )?(partenaires?|entreprises?|artisans?))\b/;
const TENDER = /\b(appels? d'offres?|appels? a candidatures?|appels? a projets?|consultations? (d'entreprises?|restreinte|ouverte)?|avis de marche|dossier de consultation|dce|remise des offres|date limite de (remise|reponse)|marche (prive|de travaux|de maitrise d'oeuvre|de services))\b/;

export const classifyPrivateNotice = (title: string, body: string): PrivateNoticeKind => {
  const text = strip(`${title || ''} ${body || ''}`).replace(/[’‘]/g, "'");
  const titleOnly = strip(title || '').replace(/[’‘]/g, "'");
  // Award / commentary wording in the headline always wins; in the body it only
  // disqualifies when no explicit call-for-bids wording is present.
  if (NOT_OPEN.test(titleOnly)) return 'skip';
  const isSub = SUBCONTRACT.test(text);
  const isTender = TENDER.test(text);
  if (!isSub && !isTender) return 'skip';
  if (NOT_OPEN.test(text) && !/\b(remise des offres|date limite|dce|dossier de consultation)\b/.test(text)) return 'skip';
  return isSub ? 'subcontracting' : 'tender';
};

/** Source summaries often carry raw HTML / entities; keep readable plain text. */
export const cleanNoticeText = (html: string | null | undefined): string => {
  if (!html) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
