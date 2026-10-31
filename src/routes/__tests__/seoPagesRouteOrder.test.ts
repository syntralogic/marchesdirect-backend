import router from '../seoPagesPublic';

// Regression: '/lookup' (and the other literal routes) were declared AFTER '/:slug', so Express answered
// GET /api/seo-pages/lookup?... with the slug handler (slug = "lookup") -> 404 for every nested local page.
describe('seoPagesPublic route order', () => {
  const paths: string[] = (router as any).stack.filter((l: any) => l.route).map((l: any) => l.route.path);

  it.each(['/lookup', '/opportunities-sitemap', '/opportunity-meta/:id'])('%s is declared before /:slug', (p) => {
    expect(paths).toContain(p);
    expect(paths.indexOf(p)).toBeLessThan(paths.indexOf('/:slug'));
  });
});
