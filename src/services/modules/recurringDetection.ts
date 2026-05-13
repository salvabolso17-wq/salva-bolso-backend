import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { capitalizeFirst } from "../../utils/formatting";

// Coisas que nunca são recorrentes na 1ª ocorrência — exclusão por sinal negativo
export const NEVER_RECURRING = [
  "mercado", "supermercado", "minimercado", "atacadão", "atacadao", "assaí", "assai", "hortifruti",
  "padaria", "confeitaria", "açougue", "acougue",
  "restaurante", "lanchonete", "cantina", "bistrô", "bistro",
  "almoço", "almoco", "jantar", "lanche", "pizza", "hamburguer", "marmita", "comida",
  "delivery", "ifood", "rappi", "uber eats", "ubereats",
  "gasolina", "etanol", "combustível", "combustivel", "abastecimento", "gnv",
  "uber", "táxi", "taxi", "99pop", "cabify", "passagem",
  "estacionamento", "pedágio", "pedagio",
  "farmácia", "farmacia", "drogaria", "remédio", "remedio", "medicamento",
  "consulta", "exame", "dentista",
  "compra", "compras", "roupa", "roupas", "sapato", "calçado", "calcado",
  "posto", "oficina", "mecânico", "mecanico", "pneu", "funilaria",
  "cinema", "teatro", "show", "ingresso", "boliche", "karting",
  "hotel", "pousada", "hostel", "airbnb", "viagem",
  "presente",
  // Compras típicas parceladas (nunca são assinaturas mensais)
  "iphone", "ipad", "macbook", "airpods",
  "notebook", "laptop", "computador", "celular", "smartphone",
  "geladeira", "fogão", "fogao", "microondas", "lavadora",
  "televisão", "televisao",
  "sofá", "sofa", "cama", "colchão", "colchao", "móveis", "moveis", "armário", "armario",
  "bicicleta",
];

// Pequena base auxiliar de serviços/contas reconhecidamente mensais
export const RECURRING_SERVICE_HINTS = [
  // Streaming
  "netflix", "spotify", "disney", "hbomax", "primevideo", "youtube", "appletv",
  "paramount", "crunchyroll", "telecine", "globoplay",
  // Cloud / produtividade
  "icloud", "dropbox", "notion", "figma", "canva", "adobe", "github",
  "chatgpt", "openai", "midjourney", "linkedin", "zoom", "slack",
  // Telecoms
  "claro", "vivo", "tim", "nextel",
  // Contas mensais comuns
  "internet", "aluguel", "academia", "condominio", "mei",
  "contador", "hospedagem", "dominio",
];

// Detecta sinais de frequência mensal/contínua no texto original da mensagem
export function detectFrequencyIntent(texto: string): boolean {
  const t = texto.toLowerCase();
  return [
    "todo mês", "todo mes", "todos os meses",
    "mensalidade", "mensalmente",
    "por mês", "por mes", "/mês", "/mes",
    "sempre pago", "sempre vem",
    "conta fixa", "gasto fixo", "valor fixo",
    "débito automático", "debito automatico",
    "todo mês pago", "pago todo mês", "pago todo mes",
    "assinatura",
    "recorrente", "recorrência", "recorrencia",
    "plano mensal",
  ].some(s => t.includes(s));
}

export function normalizeForHint(s: string): string {
  return s.toLowerCase().trim()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "");
}

export function editDistance(a: string, b: string): number {
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(dp[j], dp[j - 1], prev);
      prev = temp;
    }
  }
  return dp[n];
}

export function matchesKnownService(descricao: string): boolean {
  const d = normalizeForHint(descricao);
  for (const hint of RECURRING_SERVICE_HINTS) {
    if (d === hint || d.includes(hint) || hint.includes(d)) return true;
    if (hint.length >= 5 && Math.abs(d.length - hint.length) <= 2 && editDistance(d, hint) <= 2) return true;
  }
  return false;
}

// Detecta se um gasto tem perfil de recorrente sem depender de lista de serviços
export function isLikelyRecurring(descricao: string, valor: number, categoria: string): boolean {
  const desc = descricao.toLowerCase().trim();

  // Bail imediato: padrões que nunca são assinaturas na 1ª ocorrência
  if (NEVER_RECURRING.some(w => desc.includes(w))) return false;

  let score = 0;

  // Nome bate com serviço/conta mensal conhecida (fuzzy — tolera typos)
  if (matchesKnownService(descricao)) score += 3;

  // Categoria indica recorrência estrutural
  if (["Moradia", "Educação"].includes(categoria)) score += 2;
  else if (["Saúde", "Investimentos"].includes(categoria)) score += 1;

  // Valor com perfil de assinatura: inteiro ou terminando em .90/.99, entre R$9 e R$800
  const cents = Math.round((valor % 1) * 100);
  if ((cents === 0 || cents === 90 || cents === 99) && valor >= 9 && valor <= 800) score += 1;

  // Penalidade heurística para impulsos típicos que escaparam do NEVER_RECURRING
  const IMPULSO = ["sorvete", "doce", "bar", "chopp", "cerveja", "balada", "festa", "ingresso", "bolo", "salgado", "cafe", "café", "pao", "pão"];
  if (IMPULSO.some(w => desc.includes(w))) score -= 2;

  // Exige um score maior para passar, já que removemos bônus genéricos
  return score >= 3;
}

export async function checkHistoricalPattern(userId: number, descricao: string): Promise<boolean> {
  try {
    const descNorm = descricao.toLowerCase().trim();
    const patternRow = await pool.query<{ meses: string }>(
      `SELECT COUNT(DISTINCT DATE_TRUNC('month', criado_em)) AS meses
       FROM transactions
       WHERE user_id = $1
         AND tipo = 'saida'
         AND LOWER(descricao) = $2
         AND criado_em >= NOW() - INTERVAL '4 months'`,
      [userId, descNorm]
    );
    const mesesDistintos = Number(patternRow.rows[0]?.meses ?? 0);
    return mesesDistintos >= 2;
  } catch (err) {
    log.error("falha checkHistoricalPattern", err, { userId, descricao });
    return false;
  }
}

// Detecta recorrentes por sinal contextual (1ª ocorrência) ou por padrão histórico (2+ meses)
export async function checkAndSuggestRecorrente(userId: number, telefone: string, descricao: string, valor: number, categoria: string, textoOriginal?: string): Promise<boolean> {
  try {
    const descNorm = descricao.toLowerCase().trim();
    const now = new Date();
    const mesAtual = new Date(now.getFullYear(), now.getMonth(), 1);
    const sentinel = `rec_suggest_${descNorm.replace(/\s+/g, "_").slice(0, 40)}`;

    // Não sugerir se já é recorrente cadastrado
    const jaRecorrente = await pool.query(
      `SELECT 1 FROM recurring_expenses WHERE user_id = $1 AND LOWER(nome) = $2 LIMIT 1`,
      [userId, descNorm]
    );
    if (jaRecorrente.rows.length > 0) return false;

    // ── Strategy A: sinais contextuais → pergunta na 1ª ocorrência ───────────
    // Dispara por score de perfil OU por sinal de frequência no texto original
    const freqSignal = textoOriginal != null
      && detectFrequencyIntent(textoOriginal)
      && !NEVER_RECURRING.some(w => descNorm.includes(w));

    if (isLikelyRecurring(descricao, valor, categoria) || freqSignal) {
      const inserted = await pool.query(
        `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
        [userId, sentinel, mesAtual]
      );
      if ((inserted.rowCount ?? 0) === 0) return false;

      const nome = capitalizeFirst(descricao);
      await whatsapp.sendText({
        to:   telefone,
        text: `${nome} aparece todo mês? 🔁`,
      });
      await pool.query(
        `INSERT INTO pending_actions (user_id, action, step, tx_ids)
         VALUES ($1, 'confirmar_recorrente', 'waiting_confirmation', $2::jsonb)
         ON CONFLICT (user_id) DO UPDATE
           SET action = 'confirmar_recorrente', step = 'waiting_confirmation', tx_ids = $2::jsonb,
               selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`,
        [userId, JSON.stringify({ nome: descricao, valor, frequencia: "mensal" })]
      );
      log.whatsapp("sugestao recorrente (sinal) enviada", { to: telefone, userId, descricao, categoria });
      return true;
    }

    // ── Strategy B: padrão histórico → mesmo nome em 2+ meses diferentes ─────
    const patternRow = await pool.query<{ meses: string }>(
      `SELECT COUNT(DISTINCT DATE_TRUNC('month', criado_em)) AS meses
       FROM transactions
       WHERE user_id = $1
         AND tipo = 'saida'
         AND LOWER(descricao) = $2
         AND criado_em >= NOW() - INTERVAL '4 months'`,
      [userId, descNorm]
    );
    const mesesDistintos = Number(patternRow.rows[0]?.meses ?? 0);
    if (mesesDistintos < 2) return false;

    const inserted = await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, sentinel, mesAtual]
    );
    if ((inserted.rowCount ?? 0) === 0) return false;

    const nome = capitalizeFirst(descricao);
    await whatsapp.sendText({
      to:   telefone,
      text: `Percebi que ${nome} aparece todo mês. Isso é recorrente? 🔁`,
    });
    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids)
       VALUES ($1, 'confirmar_recorrente', 'waiting_confirmation', $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET action = 'confirmar_recorrente', step = 'waiting_confirmation', tx_ids = $2::jsonb,
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`,
      [userId, JSON.stringify({ nome: descricao, valor, frequencia: "mensal" })]
    );
    log.whatsapp("sugestao recorrente (padrao) enviada", { to: telefone, userId, descricao });
    return true;
  } catch (err) {
    log.error("falha sugestao recorrente", err, { userId });
    return false;
  }
}

// Upsert case-insensitive: UPDATE primeiro, INSERT só se nenhuma linha existir com mesmo nome (qualquer casing)
export async function upsertRecorrente(userId: number, nome: string, valor: number, frequencia: string): Promise<void> {
  const upd = await pool.query(
    `UPDATE recurring_expenses SET valor = $1, frequencia = $2, ativo = TRUE
     WHERE user_id = $3 AND LOWER(TRIM(nome)) = LOWER(TRIM($4))`,
    [valor, frequencia, userId, nome]
  );
  if ((upd.rowCount ?? 0) === 0) {
    await pool.query(
      `INSERT INTO recurring_expenses (user_id, nome, valor, frequencia) VALUES ($1, $2, $3, $4)`,
      [userId, nome, valor, frequencia]
    );
  }
}

export async function checkRecorrenteDuplicado(
  userId: number,
  descricao: string,
  valor: number,
): Promise<{ nome: string; nomeOriginal: string; recValor: number; sameValue: boolean } | null> {
  try {
    const res = await pool.query<{ nome: string; valor: string }>(
      `SELECT nome, valor FROM recurring_expenses
       WHERE user_id = $1 AND ativo = TRUE
         AND LOWER(TRIM(nome)) = LOWER(TRIM($2))
       LIMIT 1`,
      [userId, descricao]
    );
    if (!res.rows.length) return null;
    const row      = res.rows[0];
    const recValor = parseFloat(row.valor);
    const sameValue = Math.abs(recValor - valor) < 0.50;
    return { nome: capitalizeFirst(row.nome), nomeOriginal: row.nome, recValor, sameValue };
  } catch (err) {
    log.error("checkRecorrenteDuplicado falhou", err, { userId });
    return null;
  }
}
