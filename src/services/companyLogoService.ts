import https from 'https';
import dns from 'dns/promises';
import { BlockList, isIP } from 'net';
import { load } from 'cheerio';

// Deliberately narrow: no image search, favicon, social photo, guessed domain or
// generic OpenGraph picture. Missing evidence is a normal "no logo" result.
export interface LogoCompany { name?: string | null; website?: string | null; source?: string | null }
export interface CompanyLogo { dataUrl: string; source: string }
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as [string, number][]) blocked.addSubnet(network, prefix, 'ipv4');
export const publicIPv4 = (ip: string) => isIP(ip) === 4 && !blocked.check(ip, 'ipv4');
const normalized = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hostKey = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '');

export function websiteUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return null;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || isIP(u.hostname) || !u.hostname.includes('.')) return null;
    return u;
  } catch { return null; }
}

function matchesIdentifier(value: unknown, siren: string): boolean {
  if (Array.isArray(value)) return value.some(v => matchesIdentifier(v, siren));
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return /^(siren|siret|vat|tva)$/i.test(String(v.propertyID || '')) && matchesIdentifier(v.value, siren);
  }
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const s = String(value).replace(/[\s.-]/g, '').toUpperCase();
  return s === siren || (/^\d{14}$/.test(s) && s.slice(0,9) === siren) || (/^FR[A-Z0-9]{2}\d{9}$/.test(s) && s.slice(4) === siren);
}

export function verifiedLogoUrl(html: string, site: URL, siren: string, name: string): URL | null {
  const $ = load(html); const urls = new Set<string>();
  function visit(value: unknown, depth = 0) {
    if (depth > 8 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.slice(0,100).forEach(v => visit(v, depth+1)); return; }
    const v = value as Record<string, any>;
    const types = [v['@type']].flat();
    const org = types.some(t => typeof t === 'string' && /^(Organization|Corporation|LocalBusiness|ProfessionalService|HomeAndConstructionBusiness|Electrician|Plumber|HVACBusiness|RoofingContractor|GeneralContractor)$/.test(t));
    if (org && [v.name, v.legalName].some(n => typeof n === 'string' && normalized(n) === normalized(name))
      && [v.identifier, v.taxID, v.vatID].some(id => matchesIdentifier(id, siren))) {
      const orgUrl = websiteUrl(v.url);
      const rawLogo = typeof v.logo === 'string' ? v.logo : v.logo?.contentUrl || v.logo?.url;
      if (orgUrl && hostKey(orgUrl) === hostKey(site) && typeof rawLogo === 'string') {
        try {
          const logo = websiteUrl(new URL(rawLogo, site).href);
          // Same exact site (www alias permitted), no third-party logo host.
          if (logo && hostKey(logo) === hostKey(site)) urls.add(logo.href);
        } catch { /* ambiguous or malformed: do not infer */ }
      }
    }
    for (const child of Object.values(v).slice(0,100)) if (child && typeof child === 'object') visit(child, depth+1);
  }
  $('script[type="application/ld+json"]').slice(0,20).each((_i, node) => {
    try { visit(JSON.parse($(node).text())); } catch { /* invalid structured data */ }
  });
  return urls.size === 1 ? new URL([...urls][0]) : null;
}

export function rasterMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  return null;
}

// Resolve and validate INSIDE the socket lookup: checking DNS before a normal
// fetch would allow rebinding. Only public IPv4, verified TLS, no proxy or redirects.
function readPublic(url: URL, maxBytes: number): Promise<{ bytes: Buffer; type: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent: false, signal: AbortSignal.timeout(5000), timeout: 3000,
      headers: { 'User-Agent': 'MarchesDirect/1.0 (company logo verification)', Accept: '*/*', 'Accept-Encoding': 'identity' },
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, { all: true, family: 4 }).then(addresses => {
          if (!addresses.length || !addresses.every(a => publicIPv4(a.address))) return callback(new Error('Non-public address'), '', 4);
          if (options.all) (callback as any)(null, addresses);
          else callback(null, addresses[0].address, 4);
        }).catch(err => callback(err, '', 4));
      },
    }, res => {
      if (res.statusCode !== 200) { res.destroy(); reject(new Error('Page not directly available')); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(); reject(new Error('Content too large')); } else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ bytes: Buffer.concat(chunks), type: String(res.headers['content-type'] || '') }));
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

const cache = new Map<string, { until: number; logo: CompanyLogo | null }>();
const pending = new Map<string, Promise<CompanyLogo | null>>();
export async function findCompanyLogo(siren: string, company: LogoCompany): Promise<CompanyLogo | null> {
  const site = websiteUrl(company.website);
  if (!/^\d{9}$/.test(siren) || !site || !company.name || !['pappers','insee'].includes(company.source || '')) return null;
  const key = `${siren}:${company.name}:${site.href}`;
  const hit = cache.get(key); if (hit && hit.until > Date.now()) return hit.logo;
  if (pending.has(key)) return pending.get(key)!;
  // Never let optional logos monopolise the server. A busy lookup simply omits the logo.
  if (pending.size >= 2) return null;
  const job = (async () => {
    let logo: CompanyLogo | null = null;
    try {
      const page = await readPublic(site, 750_000);
      if (!/text\/html/i.test(page.type)) return null;
      const imageUrl = verifiedLogoUrl(page.bytes.toString('utf8'), site, siren, company.name!);
      if (!imageUrl) return null;
      const image = await readPublic(imageUrl, 100_000);
      const mime = rasterMime(image.bytes);
      if (mime && image.type.split(';')[0].trim().toLowerCase() === mime) logo = { dataUrl: `data:${mime};base64,${image.bytes.toString('base64')}`, source: site.href };
      return logo;
    } catch { return null; }
    finally {
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(key, { until: Date.now() + 86400000, logo });
    }
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}
