// 30 Sep client audit (point 6): the Dijon IRVE subcontracting notice states
// "qualification IRVE (Qualifelec ou équivalent)" in its conditions, yet the
// concordance said "Aucune qualification précisée dans les données
// disponibles". The match only read the AI-extracted `required_qualifications`
// fact, which was empty for that notice. When that fact is missing, the notice
// text itself is now read: only sentences that actually name a recognised
// qualification scheme are returned, verbatim - nothing is inferred.
const QUALIFICATION_RE = /\b(qualifelec|qualibat|qualipac|qualit['’]?\s?enr|qualigaz|qualiforage|qualipv|qualisol|qualibois|certibat|cefri|mase|caces|rge|irve|habilitations?\s+[ée]lectriques?|h0v|br\b|b2v|iso\s?\d{4,5}|certification|qualification)\b/i;
const REQUIRE_CUE_RE = /(exig|requis|obligatoire|doit|doivent|justifi|titulaire|d[ée]tenir|poss[ée]der|disposer|ou [ée]quivalent|conditions? de participation|capacit[ée]s?|qualification|certifi)/i;

export function extractQualificationsFromText(...texts: (string | null | undefined)[]): string | null {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    const sentences = String(text).split(/(?<=[.;!?])\s+|\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    for (const s of sentences) {
      if (s.length < 8 || s.length > 300) continue;
      if (!QUALIFICATION_RE.test(s) || !REQUIRE_CUE_RE.test(s)) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(s);
      if (found.length >= 3) return found.join(' ');
    }
  }
  return found.length > 0 ? found.join(' ') : null;
}
