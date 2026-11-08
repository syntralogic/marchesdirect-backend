import { verifiedLogoUrl, websiteUrl, publicIPv4, rasterMime } from '../companyLogoService';
const site = new URL('https://artisan.example/');
const org = { '@type':'Organization', name:'Électricité Bordeaux', url:site.href, taxID:'123456789', logo:'/logo.png' };
const html = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
describe('conservative company logo detection', () => {
  it('requires the same company name, SIREN and own website', () => {
    expect(verifiedLogoUrl(html(org),site,'123456789','Electricité Bordeaux')?.href).toBe('https://artisan.example/logo.png');
    expect(verifiedLogoUrl(html({...org,taxID:'987654321'}),site,'123456789',org.name)).toBeNull();
    expect(verifiedLogoUrl(html({...org,name:'Autre société'}),site,'123456789',org.name)).toBeNull();
    expect(verifiedLogoUrl(html({...org,taxID:undefined}),site,'123456789',org.name)).toBeNull();
  });
  it('ignores generic images, favicons and person photos', () => {
    expect(verifiedLogoUrl('<link rel="icon" href="/logo.png"><meta property="og:image" content="/photo.jpg">',site,'123456789',org.name)).toBeNull();
    expect(verifiedLogoUrl(html({...org,'@type':'Person'}),site,'123456789',org.name)).toBeNull();
    expect(verifiedLogoUrl(html({...org,logo:undefined,image:'/photo.jpg'}),site,'123456789',org.name)).toBeNull();
  });
  it('rejects external domains and ambiguous logos', () => {
    expect(verifiedLogoUrl(html({...org,logo:'https://other.example/logo.png'}),site,'123456789',org.name)).toBeNull();
    expect(verifiedLogoUrl(html({...org,url:'https://other.example'}),site,'123456789',org.name)).toBeNull();
    expect(verifiedLogoUrl(html([org,{...org,logo:'/second.png'}]),site,'123456789',org.name)).toBeNull();
  });
  it('accepts explicit SIRET/VAT identification and nested structured data', () => {
    const x={...org,taxID:undefined,identifier:{propertyID:'SIRET',value:'12345678900011'},logo:{'@type':'ImageObject',url:'/logo.png'}};
    expect(verifiedLogoUrl(html({'@graph':[x]}),site,'123456789',org.name)).not.toBeNull();
    expect(verifiedLogoUrl(html({...org,taxID:undefined,vatID:'FR99123456789'}),site,'123456789',org.name)).not.toBeNull();
  });
  it('rejects unsafe URLs and private, shared, reserved addresses', () => {
    for(const u of ['http://artisan.example','https://127.0.0.1/a','https://user:pass@artisan.example','https://artisan.example:8443','data:image/png;base64,x','https://localhost']) expect(websiteUrl(u)).toBeNull();
    for(const ip of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','192.168.0.1','172.31.0.1','0.0.0.0','::1','::ffff:127.0.0.1','224.1.1.1','198.18.0.1']) expect(publicIPv4(ip)).toBe(false);
    expect(publicIPv4('8.8.8.8')).toBe(true);
  });
  it('does not accept SVG or HTML as a downloadable logo', () => {
    expect(rasterMime(Buffer.from('<svg><script>alert(1)</script></svg>'))).toBeNull();
    expect(rasterMime(Buffer.from('<html>error</html>'))).toBeNull();
    expect(rasterMime(Buffer.from([137,80,78,71,13,10,26,10]))).toBe('image/png');
  });
});
