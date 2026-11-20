import { Parser } from "htmlparser2";

export interface HeadInfo {
  /** Text of the first <title>, trimmed; null when missing. */
  title: string | null;
  /** True when <meta name="robots"|"googlebot"> contains noindex. */
  metaNoindex: boolean;
  /** Raw href of <link rel="canonical">, if any. */
  canonical: string | null;
  /** <meta name="description">, trimmed; null when missing or empty. */
  description: string | null;
  /** og:title, trimmed. */
  ogTitle: string | null;
  /** The share image: og:image, else twitter:image. */
  ogImage: string | null;
}

/**
 * Parse only what we need from an HTML document's <head>. Stops at </head>
 * when the title and canonical are both there, so large pages cost little.
 *
 * When either is missing, it keeps reading the body: Next.js streams a slow
 * page's metadata (title, canonical, robots) at the end of the body for
 * browsers, and React moves it into the head as the page loads, so readers
 * and crawlers get a normal head. Inside the body, <title> and <link> tags
 * within <svg> (chart labels) don't count.
 */
export function parseHead(html: string): HeadInfo {
  const info: HeadInfo = { title: null, metaNoindex: false, canonical: null, description: null, ogTitle: null, ogImage: null };
  let twitterImage: string | null = null;
  let inTitle = false;
  let titleText = "";
  let titleDone = false;
  let stopped = false;
  let inBody = false;
  let svgDepth = 0;
  /** Past the head, stop once nothing is left to find. */
  const stopIfDone = () => {
    if (titleDone && info.canonical !== null) stopped = true;
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (stopped) return;
        if (name === "body") {
          inBody = true;
          stopIfDone();
          return;
        }
        if (name === "svg") svgDepth++;
        if (svgDepth > 0) return;
        if (name === "title" && !titleDone) {
          inTitle = true;
          titleText = "";
        } else if (name === "meta") {
          const metaName = (attrs.name ?? "").toLowerCase();
          if (metaName === "robots" || metaName === "googlebot") {
            if (/\bnoindex\b|\bnone\b/i.test(attrs.content ?? "")) info.metaNoindex = true;
          }
          const content = decodeEntities((attrs.content ?? "").trim()) || null;
          const property = (attrs.property ?? "").toLowerCase();
          if (metaName === "description") info.description ??= content;
          else if (property === "og:title" || metaName === "og:title") info.ogTitle ??= content;
          else if (property === "og:image" || metaName === "og:image") info.ogImage ??= content;
          else if (metaName === "twitter:image" || property === "twitter:image") twitterImage ??= content;
        } else if (name === "link") {
          const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
          if (rel.includes("canonical") && info.canonical === null && attrs.href) {
            info.canonical = decodeEntities(attrs.href.trim());
            if (inBody) stopIfDone();
          }
        }
      },
      ontext(text) {
        if (inTitle) titleText += text;
      },
      onclosetag(name) {
        if (name === "title" && inTitle) {
          inTitle = false;
          titleDone = true;
          const t = titleText.replace(/\s+/g, " ").trim();
          info.title = t.length > 0 ? decodeEntities(t) : null;
          if (info.title === null) titleDone = false;
          if (inBody) stopIfDone();
        }
        if (name === "svg" && svgDepth > 0) svgDepth--;
        if (name === "head") {
          inBody = true;
          stopIfDone();
        }
      },
    },
    { decodeEntities: false, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );

  // Feed in chunks so we can stop early on big documents.
  const chunk = 16_384;
  for (let i = 0; i < html.length && !stopped; i += chunk) {
    parser.write(html.slice(i, i + chunk));
  }
  parser.end();
  info.ogImage ??= twitterImage;
  return info;
}

/**
 * What a page shows machines, as presence and names (never the text): the
 * description, share-card tags, structured data types and main headings.
 * The page check reads it from the raw HTML; the browser view from the
 * rendered page. Comparing the two finds what only JavaScript adds.
 */
export interface PageMeta {
  description: boolean;
  ogTitle: boolean;
  ogImage: boolean;
  /** Structured data (JSON-LD) @types, sorted. */
  types: string[];
  /** JSON-LD blocks that don't parse. */
  invalid: number;
  /** <h1> elements. */
  h1: number;
}

export function pageMeta(html: string, head: HeadInfo = parseHead(html)): PageMeta {
  const ld = jsonLd(html);
  return {
    description: head.description !== null,
    ogTitle: head.ogTitle !== null,
    ogImage: head.ogImage !== null,
    types: ld.types,
    invalid: ld.invalid,
    h1: (html.match(/<h1[\s>]/gi) ?? []).length,
  };
}

/** Names for what a page shows ("description", "og:image", "type:Organization"), for the seen set. */
export function metaKeys(m: PageMeta): string[] {
  return [...(m.description ? ["description"] : []), ...(m.ogTitle ? ["og:title"] : []), ...(m.ogImage ? ["og:image"] : []), ...m.types.map((t) => `type:${t}`), ...(m.h1 > 0 ? ["h1"] : [])];
}

/** Words for a metaKeys name, for alerts. */
export function metaKeyLabel(k: string): string {
  if (k === "og:image") return "share image (og:image)";
  if (k === "h1") return "main heading (h1)";
  return k.startsWith("type:") ? `structured data ${k.slice(5)}` : k;
}

/**
 * Every JSON-LD block, head or body, parsed: `each` gets each node (inside @graph and arrays too),
 * and the count of blocks that don't parse is returned.
 */
function eachLdNode(html: string, each: (o: Record<string, unknown>) => void): number {
  let invalid = 0;
  const collect = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    if (Array.isArray(v)) return v.forEach((x) => collect(x, depth + 1));
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    each(o);
    if (o["@graph"]) collect(o["@graph"], depth + 1);
  };
  // Found with indexOf, not one regex over the page: `<script\b[^>]*…` backtracks over every
  // unclosed `<script` (a 1 MB page of them took minutes). Each step moves past what it read.
  const lower = html.toLowerCase();
  for (let i = lower.indexOf("<script"); i !== -1; i = lower.indexOf("<script", i)) {
    if (/[a-z0-9_]/.test(lower[i + 7] ?? "")) {
      i += 7;
      continue;
    }
    const open = lower.indexOf(">", i);
    const close = open === -1 ? -1 : lower.indexOf("</script>", open);
    if (close === -1) break;
    if (/type\s{0,8}=\s{0,8}["']?application\/ld\+json["'\s/]?/.test(lower.slice(i, open + 1))) {
      try {
        collect(JSON.parse(html.slice(open + 1, close).trim().replace(/^<!--|-->$/g, "")), 0);
      } catch {
        invalid++;
      }
    }
    i = close + 9;
  }
  return invalid;
}

const typesOf = (o: Record<string, unknown>): string[] => (Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]]).filter((x): x is string => typeof x === "string" && x !== "");

/** Every JSON-LD block, head or body: its @types (inside @graph and arrays too) and how many don't parse. */
export function jsonLd(html: string): { types: string[]; invalid: number } {
  const types = new Set<string>();
  const invalid = eachLdNode(html, (o) => typesOf(o).forEach((t) => types.add(t)));
  return { types: [...types].sort(), invalid };
}

/** What a page's structured data says about who runs the site: closed facts, never the values themselves. */
export interface OrganizationFacts {
  /** An Organization (or a kind of one: Corporation, LocalBusiness, NGO, NewsMediaOrganization…). */
  found: boolean;
  name: boolean;
  description: boolean;
  logo: boolean;
  /** Profiles elsewhere (`sameAs`), counted. */
  sameAs: number;
  /** A way to reach it: email, telephone or a contactPoint. */
  contact: boolean;
}

const ORG_TYPES = new Set(["Organization", "Corporation", "LocalBusiness", "NGO", "EducationalOrganization", "GovernmentOrganization", "NewsMediaOrganization", "OnlineBusiness", "OnlineStore", "Store", "SportsOrganization", "MedicalOrganization", "PerformingGroup", "Project", "ResearchOrganization", "WorkersUnion", "Consortium", "FundingScheme", "LibrarySystem", "Airline", "Cooperative"]);
const filled = (v: unknown) => (typeof v === "string" ? v.trim() !== "" : !!v && typeof v === "object");

/** The page's Organization in structured data: the first one found, or the one that says the most. */
export function organizationFacts(html: string): OrganizationFacts {
  let best: OrganizationFacts = { found: false, name: false, description: false, logo: false, sameAs: 0, contact: false };
  const size = (f: OrganizationFacts) => +f.name + +f.description + +f.logo + +(f.sameAs > 0) + +f.contact;
  eachLdNode(html, (o) => {
    if (!typesOf(o).some((t) => ORG_TYPES.has(t) || t.endsWith("Organization"))) return;
    const sameAs = Array.isArray(o.sameAs) ? o.sameAs.filter((x) => typeof x === "string").length : typeof o.sameAs === "string" ? 1 : 0;
    const f: OrganizationFacts = { found: true, name: filled(o.name), description: filled(o.description), logo: filled(o.logo), sameAs, contact: filled(o.email) || filled(o.telephone) || filled(o.contactPoint) };
    if (!best.found || size(f) > size(best)) best = f;
  });
  return best;
}

/**
 * What a page's product structured data gives an agent shopping for it, as closed facts: the
 * fields product feeds and agents' catalogs need (ChatGPT's product feed asks for a title,
 * description, link, image, price with currency, availability and brand; catalogs skip a product
 * with no image or a price of 0). Never the values themselves.
 */
export interface ProductFacts {
  /** Product (or ProductGroup, IndividualProduct…) nodes on the page. */
  products: number;
  name: boolean;
  description: boolean;
  url: boolean;
  image: boolean;
  brand: boolean;
  /** An offer with a price above 0 (or a low price, for an AggregateOffer). */
  price: boolean;
  currency: boolean;
  availability: boolean;
  /** A GTIN (any length) or an MPN. */
  identifier: boolean;
  /** The offer's price also appears in the page's own text (false when there's no price to look for). */
  priceShown: boolean;
}

const PRODUCT_TYPES = new Set(["Product", "ProductGroup", "IndividualProduct", "ProductModel", "SomeProducts", "Book", "Vehicle", "Car"]);

const priceOf = (offer: Record<string, unknown>): number | null => {
  for (const k of ["price", "lowPrice"]) {
    const v = offer[k];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^0-9.]/g, "")) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  const spec = offer.priceSpecification;
  if (spec && typeof spec === "object" && !Array.isArray(spec)) return priceOf(spec as Record<string, unknown>);
  return null;
};

/** The page's text without markup, scripts or styles, for finding a price in it. Linear: found with indexOf, like `eachLdNode`. */
function pageText(html: string): string {
  const src = html.slice(0, 2 * 1024 * 1024);
  const lower = src.toLowerCase();
  let out = "";
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      out += src.slice(i);
      break;
    }
    out += `${src.slice(i, lt)} `;
    const gt = src.indexOf(">", lt);
    if (gt === -1) break;
    const tag = /^<(script|style)\b/.exec(lower.slice(lt, lt + 8))?.[1];
    if (tag) {
      const close = lower.indexOf(`</${tag}`, gt);
      if (close === -1) break;
      i = close;
      continue;
    }
    i = gt + 1;
  }
  return out.replace(/&nbsp;|&#160;/g, " ");
}

/** The page's product: the one that says the most, with every product counted. */
export function productFacts(html: string): ProductFacts {
  let best: ProductFacts = { products: 0, name: false, description: false, url: false, image: false, brand: false, price: false, currency: false, availability: false, identifier: false, priceShown: false };
  let bestPrice: number | null = null;
  let products = 0;
  const size = (f: ProductFacts) => +f.name + +f.description + +f.url + +f.image + +f.brand + +f.price + +f.currency + +f.availability + +f.identifier;
  eachLdNode(html, (o) => {
    if (!typesOf(o).some((t) => PRODUCT_TYPES.has(t))) return;
    products++;
    const offers = (Array.isArray(o.offers) ? o.offers : o.offers ? [o.offers] : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
    const priced = offers.find((x) => priceOf(x) !== null) ?? offers[0];
    const price = priced ? priceOf(priced) : null;
    const f: ProductFacts = {
      products: 0,
      name: filled(o.name),
      description: filled(o.description),
      url: filled(o.url),
      image: filled(o.image),
      brand: filled(o.brand),
      price: price !== null,
      currency: !!priced && (filled(priced.priceCurrency) || filled((priced.priceSpecification as Record<string, unknown> | undefined)?.priceCurrency)),
      availability: offers.some((x) => filled(x.availability)),
      identifier: ["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "mpn"].some((k) => filled(o[k]) || (typeof o[k] === "number")),
      priceShown: false,
    };
    if (products === 1 || size(f) > size(best)) {
      best = f;
      bestPrice = price;
    }
  });
  if (bestPrice !== null) {
    const p = bestPrice as number;
    const text = pageText(html);
    const forms = new Set([p.toFixed(2), String(p), p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), p.toFixed(2).replace(".", ",")]);
    best.priceShown = [...forms].some((form) => new RegExp(`(^|[^0-9.,])${form.replace(/[.,]/g, (c) => `\\${c}`)}($|[^0-9])`).test(text));
  }
  return { ...best, products };
}

/** True when an X-Robots-Tag header value blocks indexing. */
export function headerNoindex(value: string | string[] | undefined): boolean {
  if (!value) return false;
  const values = Array.isArray(value) ? value : [value];
  // Values may be scoped to a bot ("googlebot: noindex"); any noindex counts.
  return values.some((v) => /\bnoindex\b|\bnone\b/i.test(v));
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/**
 * Accented Latin letters by their exact (case-sensitive) names: &aacute; is á, &Aacute; is Á.
 * Portuguese and Spanish link labels ("aquí", "más") are matched against these.
 */
const ACCENTED: Record<string, string> = {};
for (const [mark, combining] of [["acute", "\u0301"], ["grave", "\u0300"], ["circ", "\u0302"], ["tilde", "\u0303"], ["uml", "\u0308"], ["cedil", "\u0327"]] as const) {
  for (const letter of "aeiouycnAEIOUYCN") {
    const composed = (letter + combining).normalize("NFC");
    if (composed.length === 1) ACCENTED[letter + mark] = composed;
  }
}

/** Decode HTML character references, as a browser does in text and attribute values (`&amp;` → `&`). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ACCENTED[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}
