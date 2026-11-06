import { extractNoticeLocation, extractNoticeDates, parseExecutionText, locationFromTitle, wallClockToIso } from '../noticeLocation';

// Non-régression des règles de localisation et d'échéance (6 nov.). Cas tirés d'avis BOAMP réels.
const eforms = (locs: any[], buyer = { city: 'Toulon Cedex 9', cp: '83800' }) => JSON.stringify({ EFORMS: { ContractNotice: {
  'ext:UBLExtensions': { 'ext:UBLExtension': { 'ext:ExtensionContent': { 'efext:EformsExtension': { 'efac:Organizations': { 'efac:Organization': [
    { 'efac:Company': { 'cac:PartyIdentification': { 'cbc:ID': { '#text': 'ORG-0001' } }, 'cac:PostalAddress': { 'cbc:CityName': buyer.city, 'cbc:PostalZone': buyer.cp } } }] } } } } },
  'cac:ContractingParty': { 'cac:Party': { 'cac:PartyIdentification': { 'cbc:ID': { '#text': 'ORG-0001' } } } },
  'cac:ProcurementProject': { 'cac:RealizedLocation': locs.map(([c, n]) => ({ 'cac:Address': { ...(c ? { 'cbc:CityName': c } : {}), 'cbc:CountrySubentityCode': { '#text': n }, 'cac:Country': { 'cbc:IdentificationCode': { '#text': 'FRA' } } } })) } } } });

describe('lieu d’exécution, acheteur et publication séparés', () => {
  it('26-11675 : cinq communes d’exécution, acheteur à Toulon', () => {
    const l = extractNoticeLocation({ code_departement: ['31', '66'], donnees: eforms([['Balma', 'FRJ23'], ['Blagnac', 'FRJ23'], ['Font Romeu', 'FRJ15'], ['Fonsorbes', 'FRJ23'], ['Toulouse', 'FRJ23']]) });
    expect(l.execution.communes.map(c => c.name)).toEqual(['Balma', 'Blagnac', 'Font Romeu', 'Fonsorbes', 'Toulouse']);
    expect(l.execution.departments).toEqual(['31', '66']);
    expect(l.buyer).toEqual({ city: 'Toulon', postalCode: '83800', department: '83' });
    expect(l.publicationDepartments).toEqual(['31', '66']);
  });
  it('lieu inconnu reste inconnu', () => {
    const l = extractNoticeLocation({ code_departement: ['33'], donnees: JSON.stringify({ FNSimple: { organisme: { ville: 'Eysines', cp: '33320' }, initial: { natureMarche: { lieuExecution: 'Plusieurs lieux' } } } }) });
    expect(l.execution.status).toBe('inconnu');
    expect(l.execution.communes).toEqual([]);
    expect(l.buyer.city).toBe('Eysines');
  });
  it('département seulement (« (33) Gironde », « FRI12 - Gironde »)', () => {
    expect(parseExecutionText('(33) Gironde')).toEqual({ communes: [], departments: ['33'] });
    expect(parseExecutionText('FRI12 - Gironde').departments).toEqual(['33']);
  });
  it('adresse avec voie : la commune, jamais la rue', () => {
    expect(parseExecutionText('ENSMAC 16 Avenue Pey-Berland 33600 Pessac').communes.map(c => c.name)).toEqual(['Pessac']);
    expect(parseExecutionText('7 rue de Montaudon 33500 LIBOURNE').communes.map(c => c.name)).toEqual(['Libourne']);
  });
  it('commune suivie de « (19 - Corrèze) »', () => {
    expect(parseExecutionText('Tulle (19 - Corrèze)')).toEqual({ communes: [{ name: 'Tulle', slug: 'tulle', postalCode: null, department: '19' }], departments: ['19'] });
  });
  it('multisite', () => {
    expect(parseExecutionText('Siège du Syndicat, 33120 Arcachon ; Pôle Assainissement, 33380 Biganos').communes.map(c => c.slug)).toEqual(['arcachon', 'biganos']);
    expect(parseExecutionText('Libourne/ Coutras/ Saint-Denis-de-Pile / Les Billaux').communes.length).toBe(4);
  });
  it('mentions génériques rejetées', () => {
    expect(parseExecutionText('France métropolitaine et ultramarin').communes).toEqual([]);
    expect(parseExecutionText('A68 et RN88').communes).toEqual([]);
  });
  it('titre des acheteurs de l’État', () => {
    expect(locationFromTitle('(17) ROCHEFORT - BA 721 - Rénovation')).toEqual({ communes: [{ name: 'Rochefort', slug: 'rochefort', postalCode: null, department: '17' }], departments: ['17'] });
    expect(locationFromTitle('Fourniture de gaz')).toBeNull();
  });
});

describe('date limite à l’heure de Paris', () => {
  it('26-92640 : « 12:00+00:00 » de l’API contre « 12:00+01:00 » de l’avis → 12 h à Paris', () => {
    const d = extractNoticeDates({ datelimitereponse: '2026-11-06T12:00:00+00:00', gestion: JSON.stringify({ INDEXATION: { DATE_LIMITE_REPONSE: '2026-11-06T12:00:00.000+01:00' } }) });
    expect(d.deadline).toBe('2026-11-06T11:00:00.000Z');
  });
  it('décalage +02:00 erroné en décembre → heure murale de Paris', () => {
    const donnees = JSON.stringify({ EFORMS: { ContractNotice: { 'cac:TenderingProcess': { 'cac:TenderSubmissionDeadlinePeriod': { 'cbc:EndDate': '2026-12-04+01:00', 'cbc:EndTime': '12:00:00.000+02:00' } } } } });
    expect(extractNoticeDates({ datelimitereponse: '2026-12-04T12:00:00+00:00', donnees }).deadline).toBe('2026-12-04T11:00:00.000Z');
  });
  it('heure d’été et outre-mer', () => {
    expect(wallClockToIso('2026-07-01', '12:00:00')).toBe('2026-07-01T10:00:00.000Z');
    expect(wallClockToIso('2026-12-04', '12:00:00', 'America/Guadeloupe')).toBe('2026-12-04T16:00:00.000Z');
  });
});
