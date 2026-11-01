import { normalizeDepartmentCode } from '../utils/departmentRegion';
import { departmentFromPostal } from './companyProfileService';

const key = (value: string) => value.replace(/[^a-z]/gi, '').toLowerCase();
const postalKeys = new Set(['cp', 'codepostal', 'postalcode', 'postcode']);
const addressKeys = new Set(['adr', 'adresse', 'address', 'postaladdress', 'voie', 'nomvoie', 'streetaddress']);
const executionKeys = new Set(['lieuexecution', 'lieuexecutionlivraison', 'adresseexecution', 'executionaddress', 'placeofperformance']);
const buyerKeys = new Set(['organisme', 'acheteur', 'buyer', 'adresseacheteur', 'buyeraddress']);

function decoded(value: any): any {
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

// Only inspect named location/address fields. Never guess from a title, a
// reference, a phone number, a SIRET or BOAMP's list of publication departments.
function postalDepartments(value: any, depth = 0): string[] {
  if (depth > 12) return [];
  value = decoded(value);
  if (typeof value === 'string') {
    return [...value.matchAll(/\b\d{5}\b/g)].flatMap(match => {
      const department = normalizeDepartmentCode(departmentFromPostal(match[0]));
      return department ? [department] : [];
    });
  }
  if (Array.isArray(value)) return value.flatMap(item => postalDepartments(item, depth + 1));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([name, child]) => {
    if (postalKeys.has(key(name))) {
      // Preserve leading zeros: numeric values are not safe postal codes.
      return typeof child === 'string' && /^\d{5}$/.test(child.trim()) ? postalDepartments(child, depth + 1) : [];
    }
    return addressKeys.has(key(name)) ? postalDepartments(child, depth + 1) : [];
  });
}

function namedAddresses(value: any, names: Set<string>, depth = 0): any[] {
  if (depth > 12) return [];
  value = decoded(value);
  if (Array.isArray(value)) return value.flatMap(item => namedAddresses(item, names, depth + 1));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([name, child]) => names.has(key(name))
    ? [child] : namedAddresses(child, names, depth + 1));
}

export function offerDepartment(offer: any): string | undefined {
  const existing = normalizeDepartmentCode(offer.location_department);
  if (existing) return existing;
  if (offer.location_country && !['FR', 'FRA', 'FRANCE'].includes(String(offer.location_country).trim().toUpperCase())) return undefined;
  const raw = decoded(offer.raw_data);
  for (const fields of [executionKeys, buyerKeys]) {
    const departments = [...new Set(namedAddresses(raw, fields).flatMap(value => postalDepartments(value)))];
    // Conflicting execution locations cannot be replaced by the buyer's address.
    if (departments.length) return departments.length === 1 ? departments[0] : undefined;
  }
  return undefined;
}
