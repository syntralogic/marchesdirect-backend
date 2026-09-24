// ============================================================================
// ONE VALUE PER OFFICIAL DATA POINT
//
// 25 Sep client audit (école Michelet): the fiche header said "Montant non
// communiqué" and "Acheteur public" while the details block further down said
// 350 000 € and Ville d'Hénin-Beaumont. Both are true to the notice; they
// disagreed because the header reads the opportunities columns (estimated_value,
// buyer_name - frequently null on BOAMP because the connector only maps the
// flat `montant` / `nomacheteur` fields) while the details read the facts the
// AI extracted from the full notice.
//
// The rule applied here: the column wins when it holds a value; when it is
// empty, the value extracted from the notice fills it; and the extracted facts
// are then rewritten from the resolved value so every block shows the same
// figure. Nothing is invented: a value is only filled from text that literally
// states it.
// ============================================================================

const GENERIC_BUYER = /^(acheteur public|acheteur|not available|non communiqu[ée]e?|non renseign[ée]e?|n\/?a|inconnu)$/i;

export function isGenericBuyer(name: unknown): boolean {
  if (typeof name !== 'string') return true;
  const v = name.trim();
  return v.length < 3 || GENERIC_BUYER.test(v);
}

// Parses an amount stated in euros from free text: "350 000 € HT",
// "350 000 EUR", "1 250 000,50 euros". Returns null when there is no amount,
// when the text lists several different amounts (lots), or when no currency
// is named - an ambiguous figure is left out rather than guessed.
export function parseAmountEuro(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  if (!/€|eur\b|euros?\b/i.test(text)) return null;
  if (/million|milliard|\bk€|\bm€/i.test(text)) return null;
  const matches = text.match(/\d{1,3}(?:[\s\u00a0\u202f.]\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?/g);
  if (!matches) return null;
  const values = Array.from(new Set(matches.map((m) => {
    const cleaned = m.replace(/[\s\u00a0\u202f.]/g, '').replace(',', '.');
    return Number(cleaned);
  }).filter((n) => Number.isFinite(n) && n > 0)));
  return values.length === 1 ? values[0] : null;
}

const formatAmount = (n: number) => `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Math.round(n))} €`;

// Mutates the opportunity object about to be returned by the detail route.
export function reconcileOfficialFields(opp: any): void {
  const facts = opp?.ai_extracted_facts;
  if (!facts || typeof facts !== 'object') return;

  // Amount
  const hasColumnValue = opp.estimated_value != null && opp.estimated_value !== '' && Number(opp.estimated_value) > 0;
  if (!hasColumnValue && facts.estimated_value?.available) {
    const parsed = parseAmountEuro(facts.estimated_value.value);
    if (parsed != null) opp.estimated_value = parsed;
  }
  if (opp.estimated_value != null && opp.estimated_value !== '' && Number(opp.estimated_value) > 0) {
    // Keep the notice's own wording ("350 000 € HT") when it states the same
    // figure; only replace it when it disagrees or cannot be read.
    const same = facts.estimated_value?.available && parseAmountEuro(facts.estimated_value.value) === Number(opp.estimated_value);
    if (!same) facts.estimated_value = { value: formatAmount(Number(opp.estimated_value)), available: true };
  }

  // Buyer
  if (isGenericBuyer(opp.buyer_name) && facts.buyer_name?.available && !isGenericBuyer(facts.buyer_name.value)) {
    opp.buyer_name = String(facts.buyer_name.value).trim();
  }
}
