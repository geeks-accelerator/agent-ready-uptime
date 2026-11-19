/** Safe HTML for server-rendered pages: interpolations are escaped unless they are Raw. */
import { isHttpUrl } from "../url.js";

export class Raw {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(s: string): Raw {
  return new Raw(s);
}

export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** An external link target: http(s) URLs only, anything else becomes "#". */
export function safeHref(url: string | null | undefined): string {
  return url && isHttpUrl(url) ? url : "#";
}

/** Tagged template that escapes interpolations unless they are Raw (or arrays of Raw). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

function render(v: unknown): string {
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === false || v === null || v === undefined) return "";
  return esc(v);
}
