import { Parser } from "htmlparser2";
import { urlActs } from "../actions.js";
import { isHttpUrl } from "../url.js";
import { decodeEntities } from "./head.js";

/** What one HTML document weighs, and what it links to and loads. */
export interface HtmlWeight {
  /** Every <script> tag. */
  scripts: number;
  /** Bytes of script content inside the HTML. */
  inlineScriptBytes: number;
  /** Repeated page data for a JS framework: Next.js flight data (self.__next_f.push) and __NEXT_DATA__. */
  frameworkBytes: number;
  /** External scripts and stylesheets, absolute, deduplicated, in order. */
  jsUrls: string[];
  cssUrls: string[];
  images: number;
  lazyImages: number;
  /** Bytes of inline <svg> markup. */
  svgBytes: number;
  /** Element count. */
  elements: number;
  /** <a href> targets and the share image (og:image), absolute http(s), deduplicated, without #fragments. */
  links: string[];
  /** The page's speculation rules: what the browser may prefetch or prerender, and how eagerly. */
  speculation: SpeculationRule[];
  /** <html lang>, its primary tag lower-cased ("en", "pt"); null when absent. */
  lang: string | null;
  /** A search form: a <form> with <input type="search">, or an input named q, s or search. */
  searchForm: boolean;
  /** Every <a href> in order (not deduplicated): what it says and whether it sits in the site's navigation. */
  anchors: Anchor[];
  /** The id of a single-page app's mount point (`root`, `__next`, `app`, `__nuxt`, `svelte`), the first seen; null when none. */
  rootId: string | null;
  /** Elements inside that mount point in the HTML: a few (a spinner) means it's rendered in the browser; many means the server rendered it. */
  rootElements: number;
}

/** One link as a reader meets it. */
export interface Anchor {
  /** Resolved, as in `links`. */
  href: string;
  /** Its text, else aria-label, else an image's alt, else title; "(labelled by id)" for aria-labelledby; "" when none. */
  label: string;
  /**
   * In the site's navigation: inside <nav> or role=navigation anywhere, or inside
   * <header>/<footer> (role=banner/contentinfo) that isn't within <article>, <main>
   * or <section> (the ARIA landmark rule: an article's header is content).
   */
  inChrome: boolean;
  /** Its rel tokens, lower-cased and space-separated ("nofollow noopener"); "" when none. */
  rel: string;
  /**
   * Hidden from assistive technology: aria-hidden="true" or `hidden`, on the link or around it.
   * A deliberate duplicate of a labelled link beside it (an image beside a title, both linking
   * to the story) is the accessible pattern, so its label isn't judged.
   */
  hidden: boolean;
  /**
   * Following it would do something, not just read:
   * its path or label reads like an action (log out, delete, unsubscribe… `looksLikeLinkAction`), it
   * carries `data-method` or `data-confirm`, or its query has a token. The scan's graph leaves these out.
   */
  action: boolean;
}

type Region = "nav" | "chrome" | "content" | "skip" | null;

/** Mount points single-page apps render into. */
const ROOT_IDS = new Set(["root", "__next", "app", "__nuxt", "svelte"]);

const CONTENT = new Set(["article", "main", "section"]);

/** One rule of a `<script type="speculationrules">`, as when it fires. */
export interface SpeculationRule {
  action: "prefetch" | "prerender";
  /** immediate / eager (on load), moderate (on hover), conservative (on click-down). */
  eagerness: string;
}

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

/** One pass over the document with the same parser as head.ts. */
export function measureHtml(html: string, pageUrl: string): HtmlWeight {
  const w: HtmlWeight = { scripts: 0, inlineScriptBytes: 0, frameworkBytes: 0, jsUrls: [], cssUrls: [], images: 0, lazyImages: 0, svgBytes: 0, elements: 0, links: [], speculation: [], lang: null, searchForm: false, anchors: [], rootId: null, rootElements: 0 };
  // The mount point's depth in the element stack while it's open (-1: not open), to count what's inside it.
  let rootDepth = -1;
  const js = new Set<string>();
  const css = new Set<string>();
  const links = new Set<string>();
  // Attributes arrive raw (decodeEntities is off for script text), so decode them as a browser would: href="?a=1&amp;b=2" is ?a=1&b=2.
  const abs = (raw: string | undefined): string | null => {
    if (!raw) return null;
    try {
      const u = new URL(decodeEntities(raw.trim()), pageUrl);
      u.hash = "";
      return isHttpUrl(u.toString()) ? u.toString() : null;
    } catch {
      return null;
    }
  };

  let inScript = false;
  let scriptIsData = false;
  let scriptIsRules = false;
  let scriptText = "";
  let svgDepth = 0;
  let svgStart = 0;
  // Where we are: one entry per open element, so <div role="navigation"> closes with its own </div>.
  const stack: Region[] = [];
  let navDepth = 0;
  let chromeDepth = 0;
  let contentDepth = 0;
  let skipDepth = 0;
  let formDepth = 0;
  // Inside an SVG, only <title> and <text> are read out: a link's label can be either (a chart's labels are <text>).
  let svgLabelDepth = 0;
  // One entry per open element, like `stack`: whether it hid itself from assistive technology.
  const hiddenStack: boolean[] = [];
  let hiddenDepth = 0;
  let anchor: { href: string | null; text: string; aria: string; alt: string; title: string; labelledBy: boolean; inChrome: boolean; rel: string; hidden: boolean; marked: boolean } | null = null;
  const regionOf = (name: string, role: string): Region => {
    if (name === "nav" || role === "navigation") return "nav";
    if (name === "style" || name === "noscript" || name === "template") return "skip";
    if (CONTENT.has(name) || role === "main" || role === "article") return "content";
    // A header or footer counts as the site's own only outside content.
    if ((name === "header" || name === "footer" || role === "banner" || role === "contentinfo") && contentDepth === 0) return "chrome";
    return null;
  };

  const parser: Parser = new Parser(
    {
      onopentag(name, attrs) {
        w.elements++;
        const region = regionOf(name, (attrs.role ?? "").trim().toLowerCase());
        stack.push(region);
        const hides = (attrs["aria-hidden"] ?? "").trim().toLowerCase() === "true" || "hidden" in attrs;
        hiddenStack.push(hides);
        if (hides) hiddenDepth++;
        if (region === "nav") navDepth++;
        else if (region === "chrome") chromeDepth++;
        else if (region === "content") contentDepth++;
        else if (region === "skip") skipDepth++;
        if (rootDepth >= 0) w.rootElements++;
        if (w.rootId === null && attrs.id && ROOT_IDS.has(attrs.id)) {
          w.rootId = attrs.id;
          rootDepth = stack.length;
        }
        if (name === "html" && attrs.lang) w.lang = attrs.lang.trim().toLowerCase().split(/[-_]/)[0] || null;
        if (name === "form") formDepth++;
        if (name === "input" && formDepth > 0 && ((attrs.type ?? "").toLowerCase() === "search" || ["q", "s", "search"].includes((attrs.name ?? "").toLowerCase()))) w.searchForm = true;
        if (name === "search") w.searchForm = true;
        if ((name === "title" || name === "text") && svgDepth > 0) svgLabelDepth++;
        if (name === "img" && anchor && attrs.alt) anchor.alt ||= attrs.alt;
        if (name === "svg") {
          if (svgDepth === 0) svgStart = parser.startIndex;
          svgDepth++;
        } else if (name === "script") {
          w.scripts++;
          const src = abs(attrs.src);
          if (src) js.add(src);
          inScript = !attrs.src;
          scriptIsData = attrs.id === "__NEXT_DATA__";
          scriptIsRules = (attrs.type ?? "").trim().toLowerCase() === "speculationrules";
          scriptText = "";
        } else if (name === "link") {
          const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
          const href = abs(attrs.href);
          if (href && rel.includes("stylesheet")) css.add(href);
        } else if (name === "img") {
          w.images++;
          if ((attrs.loading ?? "").toLowerCase() === "lazy") w.lazyImages++;
        } else if (name === "meta") {
          // The share image is a link too: the daily sweep checks it loads, like any link on the page.
          const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
          if (key === "og:image" || key === "twitter:image") {
            const href = abs(attrs.content);
            if (href) links.add(href);
          }
        } else if (name === "a") {
          const raw = attrs.href ?? "";
          const skipped = /^(mailto:|tel:|javascript:|#)/i.test(raw.trim());
          const href = skipped ? null : abs(raw);
          if (href) links.add(href);
          // A link inside <noscript> or <template> isn't one a reader meets: kept in `links` (the sweep), not in `anchors`.
          anchor = skipDepth > 0 ? null : { href, text: "", aria: attrs["aria-label"] ?? "", alt: "", title: attrs.title ?? "", labelledBy: !!attrs["aria-labelledby"], inChrome: navDepth > 0 || chromeDepth > 0, rel: (attrs.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" "), hidden: hiddenDepth > 0, marked: "data-method" in attrs || "data-confirm" in attrs };
        }
      },
      ontext(text) {
        if (inScript) scriptText += text;
        else if (anchor && skipDepth === 0 && (svgDepth === 0 || svgLabelDepth > 0)) anchor.text += text;
      },
      onclosetag(name) {
        const region = stack.pop() ?? null;
        if (hiddenStack.pop()) hiddenDepth--;
        if (rootDepth >= 0 && stack.length < rootDepth) rootDepth = -1;
        if (region === "nav") navDepth--;
        else if (region === "chrome") chromeDepth--;
        else if (region === "content") contentDepth--;
        else if (region === "skip") skipDepth--;
        if (name === "form" && formDepth > 0) formDepth--;
        if ((name === "title" || name === "text") && svgLabelDepth > 0) svgLabelDepth--;
        if (name === "a" && anchor) {
          const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();
          if (anchor.href) {
            const label = clean(anchor.text) || clean(anchor.aria) || clean(anchor.alt) || clean(anchor.title) || (anchor.labelledBy ? "(labelled by id)" : "");
            w.anchors.push({ href: anchor.href, label, inChrome: anchor.inChrome, rel: anchor.rel, hidden: anchor.hidden, action: anchor.marked || urlActs(anchor.href, label) });
          }
          anchor = null;
        }
        if (name === "svg" && svgDepth > 0) {
          svgDepth--;
          if (svgDepth === 0) w.svgBytes += utf8(html.slice(svgStart, parser.endIndex + 1));
        } else if (name === "script" && inScript) {
          const bytes = utf8(scriptText);
          w.inlineScriptBytes += bytes;
          if (scriptIsData || scriptText.includes("self.__next_f.push")) w.frameworkBytes += bytes;
          if (scriptIsRules) w.speculation.push(...speculationRules(scriptText).filter((r) => !w.speculation.some((x) => x.action === r.action && x.eagerness === r.eagerness)));
          inScript = false;
        }
      },
    },
    { decodeEntities: false, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  w.jsUrls = [...js];
  w.cssUrls = [...css];
  w.links = [...links];
  return w;
}

/**
 * The rules in one speculation rules script, deduplicated. Eagerness defaults
 * as in the spec: `immediate` for list rules (`urls`), `conservative` for
 * document rules (`where`, or `source: "document"`). Invalid JSON: none.
 */
export function speculationRules(json: string): SpeculationRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const out: SpeculationRule[] = [];
  for (const action of ["prefetch", "prerender"] as const) {
    const rules = (parsed as Record<string, unknown> | null)?.[action];
    if (!Array.isArray(rules)) continue;
    for (const r of rules as Array<Record<string, unknown>>) {
      const document = r.source === "document" || (r.source === undefined && r.where !== undefined);
      const eagerness = typeof r.eagerness === "string" ? r.eagerness : document ? "conservative" : "immediate";
      if (!out.some((x) => x.action === action && x.eagerness === eagerness)) out.push({ action, eagerness });
    }
  }
  return out;
}
