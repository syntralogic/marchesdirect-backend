import axios from 'axios';
import dns from 'dns/promises';
import net from 'net';

// Reads the company's OWN homepage (only when its website is already known from an
// authorised source such as Google Business Profile) and keeps what the company
// itself published: Facebook / Instagram / LinkedIn links, tel: and mailto: links.
// Nothing is guessed or searched on social networks (Meta's page-search API needs
// app review and scraping Facebook is not permitted).

export interface WebsiteFindings { facebook: string | null; instagram: string | null; linkedin: string | null; phone: string | null; email: string | null }

const FB_BAD = /^(sharer|share|plugins|dialog|login|tr|policies|help|groups|events|watch|hashtag|l\.php|about|public|business|pages\/category)/i;

function firstMatch(html: string, re: RegExp, accept: (m: RegExpExecArray) => string | null): string | null {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) { const v = accept(m); if (v) return v; }
  return null;
}

export function extractFromHtml(html: string): WebsiteFindings {
  const facebook = firstMatch(html, /href=["'](https?:\/\/(?:www\.|m\.|fr-fr\.)?facebook\.com\/([^"'?#\s<>]+)[^"'\s<>]*)["']/gi, m => {
    const path = m[2].replace(/\/+$/, '');
    if (!path || FB_BAD.test(path)) return null;
    return `https://www.facebook.com/${path}`;
  });
  const instagram = firstMatch(html, /href=["'](https?:\/\/(?:www\.)?instagram\.com\/([^"'?#\s<>/]+)\/?[^"'\s<>]*)["']/gi, m =>
    /^(p|reel|explore|accounts|share)$/i.test(m[2]) ? null : `https://www.instagram.com/${m[2]}/`);
  const linkedin = firstMatch(html, /href=["'](https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company|in)\/([^"'?#\s<>/]+)[^"'\s<>]*)["']/gi, m =>
    `https://www.linkedin.com/${m[2]}/${m[3]}/`);
  const phone = firstMatch(html, /href=["']tel:([+\d\s().-]{6,25})["']/gi, m => normalizeFrPhone(m[1]));
  const email = firstMatch(html, /href=["']mailto:([^"'?\s<>]+)[^"']*["']/gi, m => {
    const e = decodeURIComponent(m[1]).trim().toLowerCase();
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) ? e : null;
  });
  return { facebook, instagram, linkedin, phone, email };
}

/** French numbers -> "01 23 45 67 89" (national) or "+33 …"; null if not plausible. */
export function normalizeFrPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+33')) d = '0' + d.slice(3);
  else if (d.startsWith('0033')) d = '0' + d.slice(4);
  if (!/^0[1-9]\d{8}$/.test(d)) return null;
  return d.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

/** SSRF guard: http(s) only, hostname must not resolve to a private/loopback address. */
export async function isSafePublicUrl(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (net.isIP(u.hostname)) return !isPrivateIp(u.hostname);
    const addrs = await dns.lookup(u.hostname, { all: true });
    return addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address));
  } catch { return false; }
}

export async function fetchWebsiteFindings(website: string): Promise<WebsiteFindings> {
  if (!(await isSafePublicUrl(website))) throw new Error('unsafe or unresolvable website URL');
  const { data } = await axios.get<string>(website, {
    timeout: 8000, maxContentLength: 1_500_000, maxRedirects: 3, responseType: 'text',
    headers: { 'User-Agent': 'MarchesDirectBot/1.0 (+prospect enrichment; contact via site)' },
    validateStatus: s => s >= 200 && s < 300,
  });
  return extractFromHtml(String(data));
}
