// Schema.org JSON-LD parser — extracts structured product data from
// <script type="application/ld+json"> tags. Handles @graph arrays, nested
// @type, and the common Product/Offer/Organization shapes used by every
// major retailer (Amazon, ASOS, Levi's, Zalando, etc.).
//
// Why this matters for deal extraction: a single <script> tag often contains
// name, price, currency, brand, seller, availability, SKU, and image URLs
// in clean machine-readable form — vastly richer than scraping the DOM.
// Phia (audit item #2) does this at a larger scale; this is the BAT-sized
// version that runs in-page via executeScript and enriches read_page output.

// Each type maps to the fields we extract.
const TYPE_MAP = {
  Product: ['name', 'description', 'sku', 'mpn', 'gtin', 'brand', 'image', 'url', 'offers', 'aggregateRating', 'review', 'color', 'size', 'category'],
  Offer: ['price', 'priceCurrency', 'availability', 'url', 'priceValidUntil', 'seller', 'itemCondition', 'eligibleQuantity'],
  AggregateOffer: ['highPrice', 'lowPrice', 'offerCount', 'priceCurrency', 'offers'],
  Organization: ['name', 'url'],
  Brand: ['name'],
  AggregateRating: ['ratingValue', 'reviewCount', 'bestRating', 'worstRating'],
  Review: ['reviewRating', 'author', 'reviewBody', 'datePublished']
};

const PRICE_RE = /^[\d.,]+$/;

function resolveValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(resolveValue).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    // @type references, nested objects
    if (v['@type']) return resolveValue(v.name || v.url || v['@id'] || '');
    return resolveValue(v.name || v.url || v['@id'] || v.price || v.ratingValue || '');
  }
  return '';
}

// Walks a JSON-LD node. "@graph" arrays are flattened; nested @type objects
// are followed one level deep.
function walkNode(node, into = []) {
  const items = Array.isArray(node) ? node : [node];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    // @graph: flatten into the same array
    if (Array.isArray(item['@graph'])) {
      walkNode(item['@graph'], into);
      continue;
    }
    into.push(item);
  }
  return into;
}

// Extract a single typed field from a JSON-LD graph, returning the first
// match with its relevant fields. Used both for the top-level product and
// for nested objects (brand, seller).
function extractByType(nodes, typeName, fieldMap) {
  for (const node of nodes) {
    const rawType = node['@type'];
    if (!rawType) continue;
    const types = Array.isArray(rawType) ? rawType : [rawType];
    for (const t of types) {
      if (t === typeName || (t.endsWith('/' + typeName)) || (t.endsWith('#' + typeName))) {
        const out = { _type: typeName };
        for (const f of fieldMap) {
          if (node[f] !== undefined) out[f] = resolveValue(node[f]);
        }
        return out;
      }
    }
  }
  return null;
}

// Public API: given page HTML OR raw JSON-LD text, return structured product data.
export function parseJsonLdFromHtml(input) {
  const nodes = [];
  const trimmed = (input || '').trim();

  // Try as raw JSON first (script innerText, how observePage passes it)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      walkNode(JSON.parse(trimmed), nodes);
    } catch (_) { /* not valid JSON, try HTML regex below */ }
  }

  // Fall back to HTML regex extraction (for full-page HTML)
  if (!nodes.length) {
    const re = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(trimmed)) !== null) {
      try {
        walkNode(JSON.parse(m[1]), nodes);
      } catch (_) { /* broken JSON-LD — skip */ }
    }
  }
  if (!nodes.length) return null;

  // Look for Product first, then fall back to any Offer
  const product = extractByType(nodes, 'Product', TYPE_MAP.Product);
  const aggregateOffer = extractByType(nodes, 'AggregateOffer', TYPE_MAP.AggregateOffer);
  const offer = extractByType(nodes, 'Offer', TYPE_MAP.Offer);
  const organization = extractByType(nodes, 'Organization', TYPE_MAP.Organization);
  const aggregateRating = extractByType(nodes, 'AggregateRating', TYPE_MAP.AggregateRating);

  const result = {};

  if (product) {
    result.name = product.name || '';
    result.description = product.description || '';
    result.sku = product.sku || product.mpn || product.gtin || '';
    result.brand = typeof product.brand === 'object' ? resolveValue(product.brand.name || product.brand) : product.brand || '';
    result.image = typeof product.image === 'string' ? product.image : (Array.isArray(product.image) ? product.image[0] : '');
    result.url = product.url || '';
    result.color = product.color || '';
    result.size = product.size || '';
    result.category = product.category || '';
  }

  // Price data — prefer AggregateOffer (price range) > Offer with price > any Offer
  const primaryOffer = aggregateOffer || (offer && offer.price && PRICE_RE.test(offer.price) ? offer : null)
    || offer;
  if (primaryOffer) {
    result.price = primaryOffer.price || '';
    result.currency = primaryOffer.priceCurrency || '';
    result.availability = primaryOffer.availability
      ? primaryOffer.availability.replace(/^.*\//, '') : '';
    result.offerUrl = primaryOffer.url || '';
    result.seller = primaryOffer.seller || '';
    if (primaryOffer.itemCondition) {
      result.itemCondition = primaryOffer.itemCondition.replace(/^.*\//, '');
    }
    if (aggregateOffer) {
      result.lowPrice = aggregateOffer.lowPrice || '';
      result.highPrice = aggregateOffer.highPrice || '';
      result.offerCount = aggregateOffer.offerCount || '';
    }
  }

  if (organization) {
    result.organization = organization.name || '';
  }
  if (aggregateRating) {
    result.rating = aggregateRating.ratingValue || '';
    result.reviewCount = aggregateRating.reviewCount || '';
  }

  // Return only if we found something material
  if (result.name || result.price || result.brand) return result;
  return null;
}

// Runs in a page context — no chrome APIs needed. Call it from executeScript.
export const JSONLD_READ_FUNC = parseJsonLdFromHtml;
