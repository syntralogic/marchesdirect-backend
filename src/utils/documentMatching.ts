// Merges two document checklists that use different vocabularies:
//  - the buyer's own wording, extracted per-tender by the DCE analysis
//    (aiService.analyzeTenderDocuments -> tenders.required_documents), e.g.
//    "Attestation d'assurance decennale en cours de validite"
//  - our internal company_documents.document_type codes (kbis, insurance,
//    dc1, dc2, dume, attestation_fiscale, attestation_sociale)
//
// routes/tenders.ts previously surfaced these as two separate lists and left
// merging them as a manual, error-prone step for the company. That was a
// deliberate choice at the time (see git history) to avoid a wrong silent
// auto-match on a compliance-critical checklist. This module does the match
// instead, but only on unambiguous keywords - anything that doesn't hit a
// rule is marked 'needs_manual_review' rather than guessed, so the caution
// is preserved: we never silently claim a match we're not confident about.

interface DocumentTypeRule {
  type: string;
  label: string; // human-readable French label, used when printing the generic (non-DCE-worded) item
  patterns: RegExp[];
}

const DOCUMENT_TYPE_RULES: DocumentTypeRule[] = [
  { type: 'kbis', label: 'Extrait Kbis', patterns: [/\bk[- ]?bis\b/i] },
  { type: 'dc1', label: 'DC1 - Lettre de candidature', patterns: [/\bdc\s?1\b/i, /lettre de candidature/i] },
  { type: 'dc2', label: 'DC2 - Declaration du candidat', patterns: [/\bdc\s?2\b/i, /d[ée]claration du candidat/i] },
  { type: 'dume', label: 'DUME', patterns: [/\bdume\b/i, /document unique de march[ée]/i] },
  {
    type: 'insurance',
    label: "Attestation d'assurance",
    patterns: [/assurance/i, /responsabilit[ée] civile/i, /d[ée]cennale/i],
  },
  {
    type: 'attestation_fiscale',
    label: 'Attestation de regularite fiscale',
    patterns: [/attestation fiscale/i, /r[ée]gularit[ée] fiscale/i, /\bimp[oô]ts?\b/i],
  },
  {
    type: 'attestation_sociale',
    label: 'Attestation de regularite sociale',
    patterns: [/attestation sociale/i, /cotisations? sociales?/i, /\burssaf\b/i, /r[ée]gularit[ée] sociale/i],
  },
];

export const DOCUMENT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  DOCUMENT_TYPE_RULES.map((r) => [r.type, r.label])
);

// Returns our internal document_type code for a piece of buyer-authored DCE
// requirement text, or null if no rule matches confidently.
export const matchDceRequirementToDocumentType = (requirementText: string): string | null => {
  if (!requirementText) return null;
  for (const rule of DOCUMENT_TYPE_RULES) {
    if (rule.patterns.some((p) => p.test(requirementText))) return rule.type;
  }
  return null;
};

export type ChecklistStatus = 'present' | 'missing' | 'needs_manual_review';

export interface UnifiedChecklistItem {
  requirement: string; // the buyer's own wording (tender-specific) or our internal label (generic-only)
  matchedDocumentType: string | null;
  status: ChecklistStatus;
  source: 'tender_specific' | 'generic';
}

// Builds one real checklist out of the tender-specific (DCE-extracted, buyer's
// wording) and generic (our internal, always-required) document lists.
// - Every tender-specific requirement is kept, tagged with whichever internal
//   type it confidently matches (or 'needs_manual_review' if none does).
// - Any generic requirement the DCE extraction didn't already cover is added
//   too, so a terse buyer notice can't cause a mandatory document to be
//   silently dropped from the checklist.
export const buildUnifiedDocumentChecklist = (
  tenderSpecificRequirements: string[],
  genericRequiredTypes: string[],
  availableDocumentTypes: string[]
): UnifiedChecklistItem[] => {
  const checklist: UnifiedChecklistItem[] = [];
  const coveredGenericTypes = new Set<string>();

  for (const requirement of tenderSpecificRequirements) {
    const matchedType = matchDceRequirementToDocumentType(requirement);
    if (matchedType) coveredGenericTypes.add(matchedType);
    checklist.push({
      requirement,
      matchedDocumentType: matchedType,
      status: matchedType
        ? availableDocumentTypes.includes(matchedType)
          ? 'present'
          : 'missing'
        : 'needs_manual_review',
      source: 'tender_specific',
    });
  }

  for (const type of genericRequiredTypes) {
    if (coveredGenericTypes.has(type)) continue;
    checklist.push({
      requirement: DOCUMENT_TYPE_LABELS[type] || type,
      matchedDocumentType: type,
      status: availableDocumentTypes.includes(type) ? 'present' : 'missing',
      source: 'generic',
    });
  }

  return checklist;
};
