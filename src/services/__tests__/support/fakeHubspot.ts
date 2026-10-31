// In-process stand-in for the HubSpot CRM API, used by the part G acceptance tests (no network, no account).
// It mimics what matters for those tests: search by one property, create / patch with property validation (HubSpot
// rejects a property that does not exist), default associations, an outage switch, and the two pipeline automations
// of the brief (task when a deal ENTERS "À rappeler" / "RDV réalisé", once per deal and stage = re-enrolment off).
// The automations are SIMULATED here: the real ones live inside HubSpot and can only be checked on the real account.
import http from 'http';
import type { AddressInfo } from 'net';

export const ALLOWED_PROPERTIES = new Set([
  'firstname', 'lastname', 'email', 'phone', 'name', 'dealname', 'pipeline', 'dealstage',
  'md_search_trade', 'md_search_area', 'md_last_journey_step', 'md_last_site_activity', 'md_offer_views_count', 'md_analyses_count',
  'md_siret', 'md_visitors_count',
  'md_request_id', 'md_request_type', 'md_request_date', 'md_market_type', 'md_market_reference', 'md_lot_reference', 'md_market_url',
  'md_compatibility_score', 'md_score_version', 'md_score_date',
  'md_answer_moyens', 'md_answer_references', 'md_answer_disponibilite', 'md_answer_zone',
  'md_dossier_status', 'md_appointment_outcome',
]);
const STAGE_CALLBACK = '6323584230';
const STAGE_HELD = '6323584233';

type Obj = { id: string; properties: Record<string, string> };
export type FakeTask = { dealId: string; stage: string; kind: 'prise_en_charge' | 'consigner_rdv' };

export class FakeHubspot {
  contacts = new Map<string, Obj>();
  companies = new Map<string, Obj>();
  deals = new Map<string, Obj>();
  tasks: FakeTask[] = [];
  assoc = new Set<string>(); // "deals:1>contacts:2"
  requests: { method: string; url: string }[] = [];
  down = false;
  private seq = 1000;
  private server!: http.Server;
  baseUrl = '';

  async start() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => this.handle(req, res, raw ? JSON.parse(raw) : {}));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() { await new Promise((r) => this.server.close(r)); }
  reset() { this.contacts.clear(); this.companies.clear(); this.deals.clear(); this.tasks = []; this.assoc.clear(); this.requests = []; this.down = false; }

  private store(type: string) { return type === 'contacts' ? this.contacts : type === 'companies' ? this.companies : type === 'deals' ? this.deals : null; }
  private send(res: http.ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
  private invalid(props: Record<string, unknown>) { return Object.keys(props).find((k) => !ALLOWED_PROPERTIES.has(k)); }
  private automate(dealId: string, oldStage: string | undefined, newStage: string | undefined) {
    if (!newStage || newStage === oldStage) return;
    const add = (kind: FakeTask['kind']) => {
      if (!this.tasks.some((t) => t.dealId === dealId && t.stage === newStage)) this.tasks.push({ dealId, stage: newStage, kind });
    };
    if (newStage === STAGE_CALLBACK) add('prise_en_charge');
    if (newStage === STAGE_HELD) add('consigner_rdv');
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: any) {
    const url = (req.url || '').split('?')[0];
    this.requests.push({ method: req.method || '', url });
    if (this.down) return this.send(res, 503, { status: 'error', message: 'HubSpot is temporarily unavailable' });
    if ((req.headers.authorization || '') !== 'Bearer test-token') return this.send(res, 401, { message: 'invalid token' });

    let m: RegExpMatchArray | null;
    if ((m = url.match(/^\/crm\/v3\/objects\/(contacts|companies|deals)\/search$/)) && req.method === 'POST') {
      const f = body.filterGroups?.[0]?.filters?.[0];
      const results = [...this.store(m[1])!.values()].filter((o) => (o.properties[f.propertyName] || '').toLowerCase() === String(f.value).toLowerCase());
      return this.send(res, 200, { results: results.slice(0, body.limit || 10) });
    }
    if ((m = url.match(/^\/crm\/v3\/objects\/(contacts|companies|deals)$/)) && req.method === 'POST') {
      const bad = this.invalid(body.properties || {});
      if (bad) return this.send(res, 400, { status: 'error', message: `Property "${bad}" does not exist` });
      const obj: Obj = { id: String(this.seq++), properties: Object.fromEntries(Object.entries(body.properties || {}).map(([k, v]) => [k, String(v)])) };
      this.store(m[1])!.set(obj.id, obj);
      if (m[1] === 'deals') this.automate(obj.id, undefined, obj.properties.dealstage);
      return this.send(res, 201, obj);
    }
    if ((m = url.match(/^\/crm\/v3\/objects\/(contacts|companies|deals)\/(\d+)$/))) {
      const obj = this.store(m[1])!.get(m[2]);
      if (!obj) return this.send(res, 404, { message: 'not found' });
      if (req.method === 'GET') return this.send(res, 200, obj);
      if (req.method === 'PATCH') {
        const bad = this.invalid(body.properties || {});
        if (bad) return this.send(res, 400, { status: 'error', message: `Property "${bad}" does not exist` });
        const old = obj.properties.dealstage;
        for (const [k, v] of Object.entries(body.properties || {})) obj.properties[k] = String(v);
        if (m[1] === 'deals') this.automate(obj.id, old, obj.properties.dealstage);
        return this.send(res, 200, obj);
      }
    }
    if ((m = url.match(/^\/crm\/v4\/objects\/(\w+)\/(\d+)\/associations\/default\/(\w+)\/(\d+)$/)) && req.method === 'PUT') {
      this.assoc.add(`${m[1]}:${m[2]}>${m[3]}:${m[4]}`);
      return this.send(res, 200, {});
    }
    return this.send(res, 404, { message: `unhandled ${req.method} ${url}` });
  }

  find(type: 'contacts' | 'companies' | 'deals', prop: string, value: string) {
    return [...this.store(type)!.values()].filter((o) => (o.properties[prop] || '').toLowerCase() === value.toLowerCase());
  }
  associated(a: 'deals' | 'contacts', aid: string, b: 'contacts' | 'companies', bid: string) { return this.assoc.has(`${a}:${aid}>${b}:${bid}`); }
}
