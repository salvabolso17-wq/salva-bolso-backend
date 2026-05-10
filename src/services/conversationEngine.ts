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

// ── Session phase ─────────────────────────────────────────────────────────────

export type ConversationPhase =
  | "onboarding"    // new user, no transactions yet
  | "registering"   // actively logging expenses
  | "exploring"     // browsing features/menu
  | "configuring"   // setting up goals / limits / recurring
  | "querying"      // checking data
  | "active";       // general use

// ── Session context ───────────────────────────────────────────────────────────

export interface InstallmentCtx {
  item: string;
  valor: number;
  totalParcelas: number;
  parcelaAtual: number;
}

export interface SessionCtx {
  userId: number;
  txCount: number;            // transactions registered this session
  seenMenuAt: Date | null;
  lastInsightAt: Date | null; // last time we sent a secondary message
  lastAction: string;
  lastCommand: string;        // last command/view shown, for follow-up disambiguation
  lastInstallment: InstallmentCtx | null; // last installment registered, for "já paguei X de Y"
  recentActions: string[];    // last 10 distinct actions, most recent first
  phase: ConversationPhase;
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
    lastInsightAt: null,
    lastAction: "",
    lastCommand: "",
    lastInstallment: null,
    recentActions: [],
    phase: "onboarding",
    sessionStart: new Date(),
    updatedAt: new Date(),
  };
  SESSIONS.set(userId, session);

  if (SESSIONS.size % 50 === 0) pruneExpired();

  return session;
}

export function getSession(userId: number): SessionCtx | null {
  const session = SESSIONS.get(userId);
  if (!session || isExpired(session)) return null;
  return session;
}

export function hasRecentAction(userId: number, action: string): boolean {
  const session = SESSIONS.get(userId);
  if (!session || isExpired(session)) return false;
  return session.recentActions.includes(action);
}

export function recordAction(userId: number, action: string): void {
  const session = SESSIONS.get(userId);
  if (!session || isExpired(session)) return;

  session.lastAction = action;
  session.updatedAt  = new Date();

  // Keep last 10 unique actions (most recent first, no duplicates)
  session.recentActions = [
    action,
    ...session.recentActions.filter(a => a !== action),
  ].slice(0, 10);

  // Update phase
  switch (action) {
    case "showed_menu":
      session.seenMenuAt = new Date();
      session.phase = "exploring";
      break;
    case "registered_transaction":
      session.txCount += 1;
      session.phase = "registering";
      break;
    case "created_goal":
    case "set_limit":
    case "created_recurring":
      session.phase = "configuring";
      break;
    case "queried_balance":
    case "queried_summary":
    case "queried_other":
      session.phase = "querying";
      break;
  }
}

// ── Insight cooldown ──────────────────────────────────────────────────────────
// Prevents secondary messages from stacking in rapid-fire or short sessions.
// Default: 10 min — at most ~3 secondary messages in a 30-min session.

export function canSendInsight(userId: number, cooldownMs = 10 * 60 * 1000): boolean {
  const session = SESSIONS.get(userId);
  if (!session || isExpired(session)) return true;
  if (!session.lastInsightAt) return true;
  return Date.now() - session.lastInsightAt.getTime() > cooldownMs;
}

export function recordInsightSent(userId: number): void {
  const session = SESSIONS.get(userId);
  if (!session || isExpired(session)) return;
  session.lastInsightAt = new Date();
  session.updatedAt = new Date();
}

// ── Contextual next-step suggestion ──────────────────────────────────────────
//
// Called when the user asks "e agora?", "o que mais posso fazer?", "tem mais?".
// Takes the session (in-memory) + txCountDb (from DB) to decide the best hint.

const FEATURE_POOL: Array<{ guard: string; text: string }> = [
  {
    guard: "queried_balance",
    text: "O saldo mostra o que sobrou do mês 💰",
  },
  {
    guard: "queried_summary",
    text: "O resumo mostra seus gastos organizados por categoria 🧾",
  },
  {
    guard: "created_goal",
    text: "Dá pra criar metas de poupança 🎯\nEx: meta viagem 3000",
  },
  {
    guard: "set_limit",
    text: "Dá pra definir um limite por categoria — eu aviso quando passar 🔔\nEx: limite alimentação 500",
  },
  {
    guard: "created_recurring",
    text: "Os recorrentes organizam suas contas fixas automaticamente 🔁",
  },
  {
    guard: "queried_other",
    text: "O ranking mostra onde vai mais o seu dinheiro 📊",
  },
];

export function getContextualNextStep(session: SessionCtx, txCountDb: number): string {
  const totalTx = txCountDb; // DB count is authoritative

  // No transactions anywhere → only valid action is to register
  if (totalTx === 0 && session.txCount === 0) {
    return "Me manda um gasto para começar 📝\nEx: 50 mercado";
  }

  // Very early user who hasn't queried yet → nudge toward first useful view
  if (totalTx <= 3 && !session.recentActions.includes("queried_balance")) {
    return "O saldo mostra o que sobrou do mês 💰";
  }

  // Active user: suggest the first feature they haven't used in this session
  for (const feature of FEATURE_POOL) {
    if (!session.recentActions.includes(feature.guard)) {
      return feature.text;
    }
  }

  // Used everything → open invitation
  return "Pode continuar registrando ou perguntar qualquer coisa 🙂";
}

// ── Last command tracking ─────────────────────────────────────────────────────
// Records which view/command was last shown so follow-up messages can be context-aware.

export function setLastCommand(userId: number, command: string): void {
  const session = SESSIONS.get(userId);
  if (!session || isExpired(session)) return;
  session.lastCommand = command;
  session.updatedAt   = new Date();
}

export function setLastInstallment(userId: number, info: InstallmentCtx): void {
  const session = SESSIONS.get(userId);
  if (!session || isExpired(session)) return;
  session.lastInstallment = info;
  session.updatedAt       = new Date();
}

export function getLastInstallment(userId: number): InstallmentCtx | null {
  const session = SESSIONS.get(userId);
  if (!session || isExpired(session)) return null;
  return session.lastInstallment;
}

// ── Intent classifier ─────────────────────────────────────────────────────────

const EXPENSE_RE = /^[\d][\d,.]*\s+\S|^(gastei|paguei|pago|comprei|tomei|saiu|custou)\s/i;
const INCOME_RE  = /^\+\s*[\d]|^(recebi|salario|salário|renda|entrada|freelance|bonus|bônus)\b/i;

const GREETING_RE = /^(oi+|op+a|ol[aá]|ola|e\s*a[ií]|tudo\s*(bem|bom|ok|certo)?|como\s+(tá|vai)|fala|fala\s+(aí|a[ií]|cmg|comigo)|começar|comecar|hi|hello|hey|bom\s*dia|boa\s*tarde|boa\s*noite|start)[\?!.]*$/i;

const EXPLORE_RE = /quero\s+ver|me\s+mostra|como\s+funciona|o\s+que\s+(voc[eê]|vc)\s+(faz|pode|conseg|d[aá])|o\s+que\s+d[aá]\s+pra\s+fa[çz]|tem\s+mais\s+coisa|quero\s+entender|me\s+explica|o\s+que\s+[eéè]\s+isso|como\s+(uso|usar|fa[çc]o)\b|o\s+que\s+tem\s+(aqui|nesse?\s+bot)?|conta\s+mais|mostra\s+a[ií]|pode\s+falar/i;

const BALANCE_RE = /\b(saldo|sobrou|restou|dispon[ií]vel|quanto\s+(tenho|sobrou|falta|gastei))\b/i;
const SUMMARY_RE = /\b(resumo|relat[oó]rio|gastei\s+esse\s+m[eê]s|quanto\s+gastei|como\s+t[aá]\s+o\s+m[eê]s|como\s+foi)\b/i;
const QUERY_RE   = /^(hoje|semana|ranking|comparar|previs[aã]o|top\s*gastos|metas?|recorrentes?|pr[oó]ximas|buscar|extrato|desafio|categorias)\b/i;

const CONFIRM_RE = /^(sim|s|yes|pode|quero|claro|n[aã]o|nao|depois|cancelar|ok|beleza|bora|certo|perfeito|t[aá])[\?!.]*$/i;

const CONFUSED_RE = /\b(n[aã]o\s+entendi|n[aã]o\s+sei|n[aã]o\s+to\s+entendendo|como\s+a(ssim)?|que\s+isso|que\s+[eéè]\s+isso|o\s+que\s+[eéè]\s+isso|hein|h[uú]m|confused)\b/i;

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

  if (t.split(/\s+/).length <= 3 && !/\d/.test(t)) return "casual";

  return "unknown";
}
