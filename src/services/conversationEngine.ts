// Conversation Engine — Intent + Context layers (additive, non-destructive)
// Sits on top of the existing whatsappService pipeline without replacing it.

// ── Intent types ──────────────────────────────────────────────────────────────

export type Intent =
  | "register_expense"
  | "register_income"
  | "query_balance"
  | "query_summary"
  | "query_other"
  | "explore"
  | "greeting"
  | "confused"
  | "confirm_action"
  | "casual"
  | "unknown";

// ── Session context ───────────────────────────────────────────────────────────

export interface SessionCtx {
  userId: number;
  txCount: number;
  seenMenuAt: Date | null;
  lastAction: string;
  sessionStart: Date;
  updatedAt: Date;
}

// ── In-memory store with 30-min TTL ──────────────────────────────────────────

const SESSIONS = new Map<number, SessionCtx>();
const SESSION_TTL_MS = 30 * 60 * 1000;

function isExpired(session: SessionCtx): boolean {
  return Date.now() - session.updatedAt.getTime() > SESSION_TTL_MS;
}

function pruneExpired(): void {
  for (const [id, session] of SESSIONS) {
    if (isExpired(session)) SESSIONS.delete(id);
  }
}

export function initSession(userId: number): SessionCtx {
  const existing = SESSIONS.get(userId);
  if (existing && !isExpired(existing)) return existing;

  const session: SessionCtx = {
    userId,
    txCount: 0,
    seenMenuAt: null,
    lastAction: "",
    sessionStart: new Date(),
    updatedAt: new Date(),
  };
  SESSIONS.set(userId, session);

  // Prune stale sessions lazily
  if (SESSIONS.size % 50 === 0) pruneExpired();

  return session;
}

export function getSession(userId: number): SessionCtx | null {
  const session = SESSIONS.get(userId);
  if (!session || isExpired(session)) return null;
  return session;
}

export function recordAction(userId: number, action: string): void {
  const session = SESSIONS.get(userId);
  if (!session || isExpired(session)) return;

  session.lastAction = action;
  session.updatedAt = new Date();

  if (action === "showed_menu") {
    session.seenMenuAt = new Date();
  } else if (action === "registered_transaction") {
    session.txCount += 1;
  }
}

// ── Intent classifier ─────────────────────────────────────────────────────────

// Patterns for spending entries — values with a description
const EXPENSE_RE = /^[\d][\d,.]*\s+\S|^(gastei|paguei|pago|comprei|tomei|saiu|custou)\s/i;
const INCOME_RE  = /^\+\s*[\d]|^(recebi|salario|salário|renda|entrada|freelance|bonus|bônus)\b/i;

const GREETING_RE = /^(oi+|op+a|ol[aá]|ola|e\s*a[ií]|tudo\s*(bem|bom|ok|certo)?|como\s+(tá|vai)|fala|fala\s+(aí|a[ií]|cmg|comigo)|começar|comecar|hi|hello|hey|bom\s*dia|boa\s*tarde|boa\s*noite|start)[\?!.]*$/i;

const EXPLORE_RE = /quero\s+ver|me\s+mostra|como\s+funciona|o\s+que\s+(voc[eê]|vc)\s+(faz|pode|conseg|d[aá])|o\s+que\s+d[aá]\s+pra\s+fa[çz]|tem\s+mais\s+coisa|quero\s+entender|me\s+explica|o\s+que\s+[eéè]\s+isso|como\s+(uso|usar|fa[çc]o)\b|o\s+que\s+tem\s+(aqui|nesse?\s+bot)?|conta\s+mais|mostra\s+a[ií]|pode\s+falar/i;

const BALANCE_RE   = /\b(saldo|sobrou|restou|dispon[ií]vel|quanto\s+(tenho|sobrou|falta|gastei))\b/i;
const SUMMARY_RE   = /\b(resumo|relat[oó]rio|gastei\s+esse\s+m[eê]s|quanto\s+gastei|como\s+t[aá]\s+o\s+m[eê]s|como\s+foi)\b/i;
const QUERY_RE     = /^(hoje|semana|ranking|comparar|previs[aã]o|top\s*gastos|metas?|recorrentes?|pr[oó]ximas|buscar|extrato|desafio|categorias)\b/i;

const CONFIRM_RE   = /^(sim|s|yes|pode|quero|claro|n[aã]o|nao|depois|cancelar|ok|beleza|bora|certo|perfeito|t[aá])[\?!.]*$/i;

const CONFUSED_RE  = /\b(n[aã]o\s+entendi|n[aã]o\s+sei|n[aã]o\s+to\s+entendendo|como\s+a(ssim)?|que\s+isso|que\s+[eéè]\s+isso|o\s+que\s+[eéè]\s+isso|n[aã]o\s+to\s+entendendo|hein|h[uú]m|confused)\b/i;

export function classifyIntent(texto: string): Intent {
  const t = texto.trim();

  if (CONFIRM_RE.test(t))  return "confirm_action";
  if (GREETING_RE.test(t)) return "greeting";
  if (CONFUSED_RE.test(t)) return "confused";
  if (EXPLORE_RE.test(t))  return "explore";
  if (INCOME_RE.test(t))   return "register_income";
  if (EXPENSE_RE.test(t))  return "register_expense";
  if (BALANCE_RE.test(t))  return "query_balance";
  if (SUMMARY_RE.test(t))  return "query_summary";
  if (QUERY_RE.test(t))    return "query_other";

  // Short casual messages that don't match anything else
  if (t.split(/\s+/).length <= 3 && !/\d/.test(t)) return "casual";

  return "unknown";
}
