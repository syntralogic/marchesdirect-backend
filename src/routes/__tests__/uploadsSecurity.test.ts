import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import uploads from '../uploads';
import { errorHandler } from '../../middleware/errorHandler';

jest.mock('../../config/database', () => ({ db: { query: jest.fn().mockResolvedValue({ rows: [] }) } }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../../services/storageService', () => ({
  ...jest.requireActual('../../services/storageService'),
  uploadCompanyFile: jest.fn(async () => ({ url: '/uploads/companies/test/test.pdf', sizeBytes: 10 })),
}));

describe('multipart uploads', () => {
  let server: Server; let base: string;
  beforeEach(async () => {
    const app = express();
    app.use((req: any, _res, next) => { req.user = { id: 'test', companyId: 'test' }; next(); });
    app.use('/api/uploads', uploads); app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/uploads`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const pdf = () => new Blob(['%PDF-1.4\ncontent'], { type: 'application/pdf' });
  it('accepts a valid small PDF with the updated upload library', async () => {
    const form = new FormData(); form.append('file', pdf(), 'document.pdf');
    expect((await fetch(base, { method: 'POST', body: form })).status).toBe(201);
  });
  it('rejects too many multipart fields and remains available afterwards', async () => {
    const form = new FormData(); form.append('file', pdf(), 'document.pdf');
    for (let n = 0; n < 12; n++) form.append(`field${n}`, 'value');
    expect((await fetch(base, { method: 'POST', body: form })).status).toBe(400);
    const valid = new FormData(); valid.append('file', pdf(), 'document.pdf');
    expect((await fetch(base, { method: 'POST', body: valid })).status).toBe(201);
  });
  it('rejects an executable disguised as a PDF', async () => {
    const form = new FormData(); form.append('file', new Blob(['<script>bad</script>'], { type: 'application/pdf' }), 'document.pdf');
    expect((await fetch(base, { method: 'POST', body: form })).status).toBe(400);
  });
});
