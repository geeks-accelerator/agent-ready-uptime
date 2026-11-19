import { SaxesParser } from "saxes";
import { gunzipSync } from "node:zlib";

/** One page listed in a sitemap, with whatever metadata the format offers. */
export interface SitemapEntry {
  url: string;
  title: string | null;
  /** <lastmod> (sitemap.xml) or pageUpdated (sitemap.json). */
  lastmod: string | null;
  /** news:publication_date (news sitemaps). */
  publishedAt: string | null;
  /** sitemap.json `created`. */
  created: string | null;
  /** sitemap.json `contentUpdated`. */
  contentUpdated: string | null;
}

export type SitemapFormat = "urlset" | "news" | "sitemapindex" | "json";

export type ParsedSitemap =
  | { kind: "urlset"; format: "urlset" | "news"; entries: SitemapEntry[] }
  | { kind: "index"; format: "sitemapindex"; children: string[] }
  | { kind: "json"; format: "json"; entries: SitemapEntry[] };

/** Largest sitemap we read, downloaded or decompressed. */
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

/** Gunzip a raw .xml.gz body without letting it expand past `maxBytes`. */
function gunzip(buf: Buffer, maxBytes: number): Buffer {
  try {
    return gunzipSync(buf, { maxOutputLength: maxBytes });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new SitemapParseError(`gzip sitemap expands past ${maxBytes} bytes`, "too_large");
    }
    throw e;
  }
}

export class SitemapParseError extends Error {
  constructor(
    message: string,
    public readonly code: "not_xml" | "not_json" | "invalid_xml" | "invalid_json" | "unknown_format" | "too_large",
  ) {
    super(message);
  }
}

/** Parse a sitemap body; picks XML or JSON from content type / URL / body. */
export function parseSitemap(body: Buffer, opts: { url: string; contentType: string | null; maxBytes?: number }): ParsedSitemap {
  let buf = body;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzip(buf, opts.maxBytes ?? MAX_SITEMAP_BYTES);
  const text = buf.toString("utf8").replace(/^﻿/, "");
  const trimmed = text.trimStart();
  const wantsJson = /json/.test(opts.contentType ?? "") || /\.json(\?|$)/i.test(opts.url);

  if (wantsJson) {
    if (trimmed.startsWith("<")) {
      throw new SitemapParseError("expected JSON but got HTML/XML (SPA fallback page?)", "not_json");
    }
    return parseJsonSitemap(text);
  }
  if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) {
    throw new SitemapParseError("expected XML but got an HTML page", "not_xml");
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseJsonSitemap(text);
  return parseXmlSitemap(text);
}

// ---------------------------------------------------------------------------
// XML (urlset, news, sitemapindex)
// ---------------------------------------------------------------------------

export function parseXmlSitemap(xml: string): ParsedSitemap {
  const parser = new SaxesParser({ xmlns: false });
  const stack: string[] = [];
  let root: string | null = null;
  let text = "";
  let current: SitemapEntry | null = null;
  let hasNews = false;
  const entries: SitemapEntry[] = [];
  const children: string[] = [];
  let parseError: Error | null = null;

  const local = (name: string) => {
    const i = name.indexOf(":");
    return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
  };

  parser.on("error", (e) => {
    parseError ??= e;
  });
  parser.on("opentag", (tag) => {
    const name = local(tag.name);
    if (root === null) root = name;
    stack.push(tag.name.toLowerCase());
    text = "";
    if (name === "url" && stack.length === 2) {
      current = { url: "", title: null, lastmod: null, publishedAt: null, created: null, contentUpdated: null };
    }
  });
  parser.on("text", (t) => {
    text += t;
  });
  parser.on("cdata", (t) => {
    text += t;
  });
  parser.on("closetag", (tag) => {
    const full = tag.name.toLowerCase();
    const name = local(full);
    const parent = stack.length >= 2 ? local(stack[stack.length - 2] ?? "") : "";
    const value = text.trim();

    if (root === "sitemapindex") {
      if (name === "loc" && parent === "sitemap" && value) children.push(value);
    } else if (current) {
      if (name === "loc" && parent === "url") current.url = value;
      else if (name === "lastmod" && parent === "url") current.lastmod = toIso(value);
      else if (full === "news:publication_date" || (name === "publication_date" && full.includes(":"))) {
        current.publishedAt = toIso(value);
        hasNews = true;
      } else if (full === "news:title") current.title = value || null;
      else if (name === "url" && stack.length === 2) {
        if (current.url) entries.push(current);
        current = null;
      }
    }
    stack.pop();
    text = "";
  });

  try {
    parser.write(xml).close();
  } catch (e) {
    parseError ??= e as Error;
  }
  if (parseError) throw new SitemapParseError(`invalid XML: ${(parseError as Error).message}`, "invalid_xml");

  if (root === "sitemapindex") return { kind: "index", format: "sitemapindex", children };
  if (root === "urlset") return { kind: "urlset", format: hasNews ? "news" : "urlset", entries };
  throw new SitemapParseError(`unknown sitemap root <${root ?? "none"}>`, "unknown_format");
}

// ---------------------------------------------------------------------------
// JSON — our sitemap.json format. Two shapes seen in the wild:
//   { fields: {...}, pages: [ {url,title,created,contentUpdated,pageUpdated} ] }
//   { site, generated, count, documents: [ ...same entry fields... ] }
// Also accepts a bare array of entries.
// ---------------------------------------------------------------------------

export function parseJsonSitemap(text: string): ParsedSitemap {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new SitemapParseError(`invalid JSON: ${(e as Error).message}`, "invalid_json");
  }
  let list: unknown[] | null = null;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["pages", "documents", "urls", "entries", "items"]) {
      if (Array.isArray(obj[key])) {
        list = obj[key] as unknown[];
        break;
      }
    }
  }
  if (!list) throw new SitemapParseError("JSON has no pages/documents array", "unknown_format");

  const entries: SitemapEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const url = str(o.url) ?? str(o.loc);
    if (!url) continue;
    entries.push({
      url,
      title: str(o.title),
      lastmod: toIso(str(o.pageUpdated) ?? str(o.lastmod) ?? str(o.updated)),
      publishedAt: toIso(str(o.publishedAt) ?? str(o.published)),
      created: toIso(str(o.created) ?? str(o.createdAt)),
      contentUpdated: toIso(str(o.contentUpdated)),
    });
  }
  return { kind: "json", format: "json", entries };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function toIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The best "how new is this entry" date available. */
export function entryDate(e: SitemapEntry): string | null {
  return e.publishedAt ?? e.created ?? e.lastmod;
}
