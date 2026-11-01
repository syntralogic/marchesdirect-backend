import { isTestCompany } from './companyProfileService';
import { hubspotRequest } from './hubspotJourneySchema';

// A manually marked company is a test too. Fail closed if HubSpot cannot
// answer: a retry must never create commercial activity for an unknown flag.
export async function isTestCrmCompany(companyId: string | null, siret: string, name?: string | null,
  request: (cfg: any) => Promise<any> = hubspotRequest): Promise<boolean> {
  if (isTestCompany(siret, name)) return true;
  if (!companyId) return false;
  const company = await request({method: 'GET', url: `/crm/v3/objects/companies/${companyId}`, params: {properties: 'md_is_test'}});
  return String(company.properties?.md_is_test).toLowerCase() === 'true';
}
