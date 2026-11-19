/**
 * Does a name or a link read like an action, something a request would do rather than
 * read? One splitter, two vocabularies: API operations (never probed, even as GET) and
 * links a reader clicks (never counted as a way on by the scan's link graph).
 */

/**
 * Words of a name in any style: camelCase (exportUsers), snake_case, kebab-case, a path, a
 * sentence. Accents are stripped (exportação → exportacao), so one ASCII vocabulary covers pt and es.
 */
function wordsOf(names: Array<string | undefined | null>): string[] {
  return names
    .filter((n): n is string => typeof n === "string")
    .flatMap((n) =>
      n
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u),
    )
    .filter(Boolean);
}

const hasWord = (set: ReadonlySet<string>, w: string) => set.has(w) || (w.endsWith("s") && set.has(w.slice(0, -1))) || (w.endsWith("es") && set.has(w.slice(0, -2)));

/** API operations that start work on a GET at some sites. */
const API_ACTIONS = new Set([
  "export", "send", "run", "sync", "delete", "purge", "refresh", "trigger", "notify", "email", "webhook", "reset", "import", "cron", "job",
  // Added after the scan's code review (2026-11-18): verbs that change state when a site lets GET do it.
  "clear", "flush", "invalidate", "deploy", "publish", "unpublish", "cancel", "approve", "reject", "confirm", "revoke", "rotate", "generate",
  "rebuild", "reindex", "restart", "shutdown", "remove", "charge", "pay", "refund", "invite", "logout", "signout", "unsubscribe", "subscribe",
  "exportar", "exportacao", "enviar", "excluir", "eliminar", "borrar", "apagar", "cancelar", "sincronizar",
]);

/** Whether an API operation's name, summary or path reads like an action (plurals included: exports). */
export function looksLikeAction(...names: Array<string | undefined | null>): boolean {
  return wordsOf(names).some((w) => hasWord(API_ACTIONS, w));
}

/** Single words on a link that change something, in the languages the page checks read (en, pt, es). */
const LINK_ACTION_WORDS = new Set([
  "logout", "signout", "delete", "remove", "unsubscribe", "confirm", "vote", "upvote", "downvote", "checkout",
  "sair", "excluir", "apagar", "remover", "descadastrar", "confirmar", "votar",
  "salir", "eliminar", "borrar", "baja",
]);

/** Phrases of more than one word, matched on whole words. */
const LINK_ACTION_PHRASES = ["log out", "sign out", "add to cart", "add to basket", "adicionar ao carrinho", "cerrar sesión", "añadir al carrito", "agregar al carrito", "darse de baja", "cancelar inscrição"].map((p) => wordsOf([p]).join(" "));

/** A query value that looks like a one-time token (a signed link: unsubscribe, confirm, magic sign-in). */
const TOKEN_PARAM = /^(token|sig|signature|hash|nonce|code|key|auth|otp|t)$/i;
/** A query parameter named like a one-time token or signature (`token`, `sig`, `code`, `otp`...). */
export const tokenParam = (name: string) => TOKEN_PARAM.test(name);

/** A query parameter whose value says what the request does (`?action=logout`, `?do=delete`, `?method=DELETE`). */
const VERB_PARAM = /^(action|do|cmd|command|op|mode|task|method)$/i;

/**
 * Whether a query reads like an action: a token-looking value (a signed link), a parameter named
 * like one (`?logout`, `?confirm=1`), or a verb parameter's value that is one, in either vocabulary
 * (`?action=logout`, `?mode=purge`). A search term (`?q=delete account`) is data, never read.
 */
export function queryActs(params: Iterable<[string, string]>): boolean {
  for (const [k, v] of params) {
    if (TOKEN_PARAM.test(k) && v.length >= 8) return true;
    if (looksLikeLinkAction(k)) return true;
    if (VERB_PARAM.test(k) && (looksLikeLinkAction(v) || looksLikeAction(v))) return true;
  }
  return false;
}

/**
 * Would requesting this URL do something, not just read? Its path (or label) reads like an action
 * (`looksLikeLinkAction`), or its query does (`queryActs`). For links on pages, sitemap and nav URLs
 * before the scan plans them, docs links before the scan follows one, every scan request, the daily
 * probes' URLs and the free broken-link sweep.
 */
export function urlActs(href: string, label = ""): boolean {
  try {
    const u = new URL(href);
    if (queryActs(u.searchParams)) return true;
    return looksLikeLinkAction(safeDecode(u.pathname), label);
  } catch {
    return looksLikeLinkAction(href, label);
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Whether a link (its path, label or both) reads like an action a crawler must never trigger. */
export function looksLikeLinkAction(...names: Array<string | undefined | null>): boolean {
  const words = wordsOf(names);
  if (words.some((w) => hasWord(LINK_ACTION_WORDS, w))) return true;
  const text = ` ${words.join(" ")} `;
  return LINK_ACTION_PHRASES.some((p) => text.includes(` ${p} `));
}
