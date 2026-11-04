import { buildVisitNote, callbackMomentLabel, dossierPdfFilename, isTestRequest, parseCallbackMoment, requestTypeOfLead } from '../requestFacts';

describe('requestFacts', () => {
  it('accepts only the three callback moments', () => {
    expect(parseCallbackMoment('apres_midi')).toBe('apres_midi');
    expect(parseCallbackMoment('demain_matin')).toBe('demain_matin');
    expect(parseCallbackMoment('hier')).toBeNull();
    expect(parseCallbackMoment(undefined)).toBeNull();
    expect(callbackMomentLabel('maintenant')).toContain('9 h à 18 h');
    expect(callbackMomentLabel('apres_midi')).toBe('Cet après-midi');
  });

  it('marks test data from the request flag or the server env, never otherwise', () => {
    expect(isTestRequest(true, {} as any)).toBe(true);
    expect(isTestRequest('true', {} as any)).toBe(true);
    expect(isTestRequest(undefined, { MARK_LEADS_AS_TEST: '1' } as any)).toBe(true);
    expect(isTestRequest(false, {} as any)).toBe(false);
    expect(isTestRequest(undefined, {} as any)).toBe(false);
  });

  it('classifies requests by their origin', () => {
    expect(requestTypeOfLead({ lead_source: 'alert_request' })).toBe('alert');
    expect(requestTypeOfLead({ appointment_mode: 'slot' })).toBe('appointment');
    expect(requestTypeOfLead({ lead_source: 'callback_modal' })).toBe('callback');
    expect(requestTypeOfLead({ lead_source: 'analysis_gate' })).toBe('dossier');
    expect(requestTypeOfLead({ lead_source: 'contact_form', message: 'Bonjour' })).toBe('question');
  });

  it('writes the callback moment, the question and the requested slot in clear text, one note for the whole visit', () => {
    const note = buildVisitNote({
      visitDate: '2026-11-03T09:00:00Z', company: 'NET SERVICES', siret: '12345678901234', source: 'google', campaign: 'nov', isTest: true,
      requests: [
        { type: 'callback', at: '2026-11-03T09:05:00Z', marketTitle: 'Maintenance CVC', callbackMoment: 'demain_matin', phone: '0612345678' },
        { type: 'question', at: '2026-11-03T09:10:00Z', message: 'Faut-il une  qualification ?\nMerci' },
        { type: 'appointment', at: '2026-11-03T09:12:00Z', slotAt: '2026-11-05T13:00:00Z' },
      ],
    });
    expect(note).toContain('[DONNÉES DE TEST]');
    expect(note).toContain('NET SERVICES (SIRET 12345678901234)');
    expect(note).toContain('Origine : google / nov');
    expect(note).toContain('Moment de rappel choisi : Demain matin');
    expect(note).toContain('Question : « Faut-il une qualification ? Merci »');
    expect(note).toContain('Créneau souhaité');
    expect(note).toContain('à confirmer par téléphone');
    expect(note).not.toMatch(/réservé/i);
  });

  it('names the PDF after the company, ASCII only', () => {
    expect(dossierPdfFilename('Établissements Dupont & Fils')).toBe('dossier-etablissements-dupont-fils.pdf');
    expect(dossierPdfFilename('')).toBe('dossier-pre-rempli.pdf');
    expect(dossierPdfFilename(null)).toBe('dossier-pre-rempli.pdf');
  });
});
