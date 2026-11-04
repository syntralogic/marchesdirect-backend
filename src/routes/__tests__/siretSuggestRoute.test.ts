import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

jest.mock('../../config/database', () => ({ db: { query: jest.fn(), transaction: jest.fn() } }));
jest.mock('../../services/companySuggestService', () => ({ suggestCompanies: jest.fn() }));

import siretRouter from '../siret';
import { suggestCompanies } from '../../services/companySuggestService';

const suggest = suggestCompanies as jest.Mock;

function get(server: http.Server, path: string): Promise<{ status: number; body: any }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : null }));
    }).on('error', reject);
  });
}

describe('GET /api/siret/suggest', () => {
  let server: http.Server;
  beforeAll(done => {
    const app = express();
    app.use('/api/siret', siretRouter);
    server = app.listen(0, '127.0.0.1', done);
  });
  afterAll(done => { server.close(done); });
  beforeEach(() => suggest.mockReset());

  it('returns the suggestions', async () => {
    suggest.mockResolvedValue({ suggestions: [{ siret: '12345678900011', name: 'ACME' }] });
    const r = await get(server, '/api/siret/suggest?q=acme');
    expect(r.status).toBe(200);
    expect(r.body.suggestions[0].name).toBe('ACME');
    expect(suggest).toHaveBeenCalledWith('acme');
  });

  it('answers 502 with an empty list when the registry is down, so the page can fall back to the SIRET', async () => {
    suggest.mockRejectedValue(new Error('down'));
    const r = await get(server, '/api/siret/suggest?q=acme');
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: 'suggest_unavailable', suggestions: [] });
  });
});
