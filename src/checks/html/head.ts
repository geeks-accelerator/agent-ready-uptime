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

/** Every JSON-LD block, head or body: its @types (inside @graph and arrays too) and how many don't parse. */
export function jsonLd(html: string): { types: string[]; invalid: number } {
  const types = new Set<string>();
  let invalid = 0;
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(collect);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const t = o["@type"];
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "string" && x) types.add(x);
    if (o["@graph"]) collect(o["@graph"]);
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
        collect(JSON.parse(html.slice(open + 1, close).trim().replace(/^<!--|-->$/g, "")));
      } catch {
        invalid++;
      }
    }
    i = close + 9;
  }
  return { types: [...types].sort(), invalid };
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
