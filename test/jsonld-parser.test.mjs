// JSON-LD parser — the regression that matters is the NESTED typed node: the
// overwhelmingly common shape is a Product with its Offer/Brand/AggregateRating
// nested inline (`offers: {"@type":"Offer",...}`), and the parser used to only
// find typed nodes that sat flat at the top of the graph — so price, currency,
// seller, brand, and rating were silently missing on exactly the pages the
// feature exists for.

const B = new URL('../src/', import.meta.url).href;
const { parseJsonLdFromHtml } = await import(B + 'lib/jsonld-parser.js');

export default function run(t) {
  // ── nested Offer inside Product (the single-script retail shape) ──
  const nested = parseJsonLdFromHtml(JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Men\'s Trucker Jacket',
    sku: 'TK-100',
    offers: {
      '@type': 'Offer',
      price: '79.99',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      seller: { '@type': 'Organization', name: 'Levi\'s Store' }
    }
  }));

  t('nested Offer discovered', !!nested);
  t('nested price extracted', nested?.price === '79.99');
  t('nested currency extracted', nested?.currency === 'USD');
  t('nested availability extracted', nested?.availability === 'InStock');
  t('nested seller (Organization) extracted', nested?.seller === 'Levi\'s Store');

  // ── nested Brand and AggregateRating ──
  const brand = parseJsonLdFromHtml(JSON.stringify({
    '@type': 'Product',
    name: 'Shoes',
    brand: { '@type': 'Brand', name: 'Adidas' },
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5', reviewCount: '120' }
  }));

  t('nested Brand extracted', brand?.brand === 'Adidas');
  t('nested AggregateRating rating extracted', brand?.rating === '4.5');
  t('nested AggregateRating reviewCount extracted', brand?.reviewCount === '120');

  // ── flat @graph shape still works ──
  const graph = parseJsonLdFromHtml(JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Product', name: 'Watch', offers: { '@type': 'Offer', price: '199' } },
      { '@type': 'Organization', name: 'Watches Inc' }
    ]
  }));

  t('graph product found', graph?.name === 'Watch');
  t('graph nested offer found', graph?.price === '199');
  t('graph organization found', graph?.organization === 'Watches Inc');

  // ── full HTML with script tags ──
  const html = '<html><body>'
    + '<script type="application/ld+json">{"@type":"Product","name":"Bag","offers":{"@type":"Offer","price":"49.5"}}</script>'
    + '</body></html>';

  t('HTML script tag parsed', parseJsonLdFromHtml(html)?.price === '49.5');

  // ── degenerate input never throws ──
  const safe = (fn) => { try { return { ok: true, value: fn() }; } catch { return { ok: false }; } };
  t('null input does not throw', safe(() => parseJsonLdFromHtml(null)).ok);
  t('undefined input does not throw', safe(() => parseJsonLdFromHtml(undefined)).ok);
  t('empty string yields null', parseJsonLdFromHtml('') === null);
  t('non-json text yields null', parseJsonLdFromHtml('hello world') === null);
  t('broken json yields null', parseJsonLdFromHtml('{"@type":') === null);

  // ── offer array inside offers (e.g. multiple options) ──
  const offerArray = parseJsonLdFromHtml(JSON.stringify({
    '@type': 'Product',
    name: 'Bundle',
    offers: [
      { '@type': 'Offer', price: '10' },
      { '@type': 'Offer', price: '20' }
    ]
  }));

  t('offer array nested in offers discovered', offerArray?.price === '10');
}
