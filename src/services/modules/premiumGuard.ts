import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import type { UserRow } from "../types";

export function isSubscriptionActive(user: UserRow): boolean {
  const status = (user.subscription_status ?? "").trim().toLowerCase();

  if (status === "expired") return false;

  if (status === "active") {
    if (!user.subscription_expires_at) return true;
    return new Date(user.subscription_expires_at) > new Date();
  }

  if (status === "trial") {
    return !user.trial_ends_at || new Date(user.trial_ends_at) > new Date();
  }

  return false; // qualquer status desconhecido = bloqueado
}

export function isBlockedFreemium(texto: string): boolean {
  const t = texto.trim().toLowerCase();

  if (/^(ranking|comparar|previs[aã]o|categorias|desafio|metas|recorrentes|pr[oó]ximas|top\s*gastos|parcelas|relat[oó]rios?|insights?|apagar|corrigir)$/i.test(t)) return true;
  if (/^(meta|guardar|recorrente|limite)\s+/i.test(t)) return true;

  if (/quero\s+apagar|apagar\s+o\s+[uú]ltimo|remover\s+(o\s+)?[uú]ltimo|deletar\s+(o\s+)?[uú]ltimo/.test(t)) return true;
  if (/registrei\s+errado|coloquei\s+errado|lancei\s+errado/.test(t)) return true;
  if (/(qual\s+(é\s+o\s+)?meu\s+maior\s+gasto|onde\s+gastei\s+mais|onde\s+vai\s+(meu\s+)?dinheiro|maior\s+gasto\s+do\s+m[eê]s)/i.test(t)) return true;

  // Import detectGoalIntent inline check — avoids circular import with goals handler
  // We replicate the patterns here to keep modules independent
  if (_goalIntentMatch(texto)) return true;

  return false;
}

// Inline replication of detectGoalIntent patterns for freemium guard
// (avoids importing from handlers/goals which would create a circular dep)
function _goalIntentMatch(texto: string): boolean {
  const t  = texto.trim();
  const tl = t.toLowerCase();

  if (/^(?:quero\s+)?(?:guard|poup|junt)(?:ar|a)\s+dinheiro\s+(?:na?|no|pra?|para|pro?s?)\s+(.+)$/.test(tl)) return true;
  if (/^(?:quero\s+)?(?:criar\s+)?uma?\s+meta\s+(?:pra?|para|pro?)\s+(.+)$/.test(tl)) return true;
  if (/^quanto\s+falta\s*(?:(?:pra?|para|pro?)\s+(.+?))?[?!.]*$/.test(tl)) return true;
  if (/^como\s+t[aá]\s+(?:(?:a|minha?)\s+)?meta(?:\s+(?:de|do?a?)\s+(.+?))?[?!.]*$/.test(tl)) return true;
  if (/^como\s+t[aá]\s+(?:o\s+)?meu?\s+objetivo[?!.]*$/.test(tl)) return true;
  if (/^consegui\s+(?:guard|poup|junt|separ|coloc)(?:ar|a)\s+(?:mais\s+)?([\d,.]+)\s*(?:(?:na?|no|pra?|para|pro?|em)\s+(.+))?$/i.test(t)) return true;
  if (/^(?:quero\s+)?(?:guard|poup|junt|separ|coloc|bot|adicion)(?:ar|a)\s+([\d,.]+)\s*(?:(?:na?|no|pra?|para|pro?|em)\s+(.+))?$/i.test(t)) return true;
  if (/^(?:j[aá]\s+)?(?:guard|poup|junt|separ|coloc)ei\s+([\d,.]+)\s*(?:(?:na?|no|pra?|para|em)\s+(.+))?$/i.test(t)) return true;
  if (/\b(qual\s+(é\s+|é\s+a\s+|a\s+)?porcentagem|que\s+porcentagem|qual\s+o\s+percentual|que\s+percentual)\b[?!.]*/.test(tl)) return true;
  if (/^quanto\s+(?:j[aá]\s+)?(juntei|guardei|poupei)[?!.]*$/.test(tl)) return true;
  if (/^quanto\s+tenho\s+guardado[?!.]*$/.test(tl)) return true;
  if (/^quanto\s+eu\s+j[aá]\s+(juntei|guardei|poupei)[?!.]*$/.test(tl)) return true;

  return false;
}

// Envia aviso limpo de expiração apenas uma vez
export async function checkAndSendExpirationNotice(userId: number, telefone: string, expirouEm: Date): Promise<boolean> {
  const expirouEmDate = new Date(Date.UTC(expirouEm.getUTCFullYear(), expirouEm.getUTCMonth(), expirouEm.getUTCDate()));

  let fullNovo = false;
  try {
    const ins = await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, 'expiracao_aviso_v4', 1, $2::date)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, expirouEmDate]
    );
    fullNovo = (ins.rowCount ?? 0) > 0;
  } catch { /* continua */ }

  if (fullNovo) {
    log.webhook("enviando aviso de expiracao LONGO (primeira vez)", { userId });

    // Estatísticas do trial pra personalizar a mensagem
    let qtdGastos = 0;
    let totalGastos = 0;
    let qtdLembretes = 0;
    try {
      const [g, t, l] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
          [userId]
        ),
        pool.query<{ total: string }>(
          `SELECT COALESCE(SUM(valor), 0)::text AS total FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
          [userId]
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM lembretes WHERE user_id = $1`,
          [userId]
        ),
      ]);
      qtdGastos    = Number(g.rows[0]?.count ?? 0);
      totalGastos  = Number(t.rows[0]?.total ?? 0);
      qtdLembretes = Number(l.rows[0]?.count ?? 0);
    } catch (err) {
      log.error("falha buscar estatisticas trial", err, { userId });
    }

    const planos = [
      "🏆 *Anual — R$ 99,90* (R$ 8,32/mês — mais escolhido)",
      "💳 *Mensal — R$ 14,90*",
      "",
      "Cancela quando quiser, sem multa.",
      "",
      "👉 https://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html",
    ];

    let mensagem: string;
    if (qtdGastos === 0) {
      mensagem = [
        "✨ *Seus 7 dias acabaram.*",
        "",
        "Você não chegou a testar de verdade — que tal continuar e usar?",
        "",
        ...planos,
      ].join("\n");
    } else {
      const totalFmt = "R$ " + totalGastos.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      mensagem = [
        "✨ *Seus 7 dias acabaram.*",
        "",
        "Em 1 semana com você, eu:",
        `📝 Registrei *${qtdGastos}* gastos`,
        `💰 Acompanhei *${totalFmt}* do seu mês`,
        `⏰ Salvei *${qtdLembretes}* lembretes de contas`,
        "",
        "Pra continuar, escolhe seu plano:",
        "",
        ...planos,
      ].join("\n");
    }

    await whatsapp.sendText({ to: telefone, text: mensagem });
    return true;
  }

  log.webhook("aviso longo ja foi enviado antes, ignorando para usar o curto", { userId });
  return false;
}
