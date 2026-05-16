import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor } from "../../utils/formatting";
import { fetchPeriodMetrics } from "../reportService";
import { parseValor, parseTransaction } from "../../utils/parseTransaction";
import type { UserRow, ProcessResult } from "../types";

// Soma das contas fixas ativas (lembretes fixa=true, status != cancelado)
async function somaContasFixas(userId: number): Promise<number> {
  const r = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(valor), 0)::text AS total
     FROM lembretes
     WHERE user_id = $1 AND fixa = TRUE AND status <> 'cancelado'`,
    [userId]
  );
  return Number(r.rows[0]?.total ?? 0);
}

export async function handleOnboardingRenda(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  const textoTrim = texto.trim();
  const skipRenda = /^(n[aã]o\s+sei|n[aã]o\s+tenho|sem\s+renda|pula|pular|depois|n[aã]o\s+quero|prefiro\s+n[aã]o|ignore|ignora|skip)[\?!.]*$/i.test(textoTrim);

  if (skipRenda) {
    // Pular renda e ir direto para despesas fixas
    await pool.query(
      `UPDATE pending_actions
       SET step = 'waiting_onboarding_fixas',
           expires_at = NOW() + INTERVAL '1 hour'
       WHERE user_id = $1`,
      [user.id]
    );

    const msg = [
      "Tranquilo, dá pra informar depois ⏭️",
      "",
      "🏠 Tem alguma *conta fixa* todo mês?",
      "_Aluguel, luz, internet, celular..._",
      "",
      "💡 _Ex: aluguel 1200_",
      "⏭️ _ou mande 'pular'_",
    ].join("\n");

    await whatsapp.sendText({ to: telefone, text: msg });
    return { success: false, userId: user.id, erro: "onboarding renda skip" };
  }

  // Verifica se é um número ou frase tipo "ganho 3000"
  const valor = parseValor(texto.replace(/R\$\s*/i, "").trim());

  if (isNaN(valor) || valor <= 0) {
    // Se o usuário já mandou uma despesa no meio do onboarding, abortamos o onboarding
    const parsedAsExpense = parseTransaction(textoTrim);
    if (parsedAsExpense && parsedAsExpense.tipo === "saida") {
       await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
       return { success: false, userId: user.id, erro: "onboarding abortado (gasto)" };
    }

    await whatsapp.sendText({ to: telefone, text: "Hum, não entendi o valor 🤔\n💡 _Ex: 3500_ ou digite _'pular'_" });
    return { success: false, userId: user.id, erro: "onboarding renda invalida" };
  }

  // Atualizar renda e mover para a próxima etapa
  await pool.query(`UPDATE users SET renda = $1 WHERE id = $2`, [valor, user.id]);
  await pool.query(
    `UPDATE pending_actions
     SET step = 'waiting_onboarding_fixas',
         expires_at = NOW() + INTERVAL '1 hour'
     WHERE user_id = $1`,
    [user.id]
  );

  const msg = [
    `💰 Renda anotada: *${fmtValor(valor)}*`,
    "",
    "🏠 Tem alguma *conta fixa* todo mês?",
    "_Aluguel, luz, internet, celular..._",
    "",
    "💡 _Ex: aluguel 1200_",
    "⏭️ _ou mande 'pular'_",
  ].join("\n");

  await whatsapp.sendText({ to: telefone, text: msg });
  return { success: false, userId: user.id, erro: "onboarding fixas_ask" };
}

export async function handleOnboardingFixas(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  const textoTrim = texto.trim();
  const skipFixas = /^(n[aã]o|pula|pular|depois|n[aã]o\s+quero|ignore|ignora|skip|nada)[\?!.]*$/i.test(textoTrim);

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  if (skipFixas) {
    const renda = Number(user.renda ?? 0);
    const msg = [
      "Tudo pronto! 🎉",
      "",
      "Manda teu primeiro gasto:",
      "🛒 _50 mercado_ • 🚗 _35 uber_ • 💊 _120 farmácia_",
    ].join("\n");
    await whatsapp.sendText({ to: telefone, text: msg });
    return { success: false, userId: user.id, erro: "onboarding finalizado (skip fixas)" };
  }

  // Tenta parsear como uma despesa. Se der certo, abre o fluxo de 3 passos (dia → status).
  const parsed = parseTransaction(textoTrim);
  if (parsed && parsed.tipo === "saida") {
    const descricao = parsed.descricao || "conta fixa";
    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
       VALUES ($1, 'onboarding_fixa_aguardando_dia', 'waiting_dia', $2::jsonb, NOW() + INTERVAL '1 hour')
       ON CONFLICT (user_id) DO UPDATE
         SET action = 'onboarding_fixa_aguardando_dia', step = 'waiting_dia', tx_ids = $2::jsonb,
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '1 hour'`,
      [user.id, JSON.stringify({ titulo: descricao, valor: parsed.valor })]
    );
    await whatsapp.sendText({
      to:   telefone,
      text: `📅 Qual dia do mês vence o *${capitalizeFirst(descricao)}*?\n💡 _Ex: 5_`,
    });
    return { success: false, userId: user.id, erro: "onboarding fixa aguardando dia" };
  }

  // Se não conseguir parsear, apenas finaliza
  const msgFalha = [
    'Sem problemas! Você pode adicionar contas fixas depois mandando algo como: _"lembra de pagar aluguel dia 5, 1200, todo mês"_.',
    "",
    "Por enquanto, vamos começar pelos gastos do dia a dia.",
    "",
    "Manda agora qualquer gasto que você fez hoje:",
    "🛒 _50 mercado_ • 🚗 _35 uber_ • 💊 _120 farmácia_",
    "",
    "Eu organizo, categorizo e te mostro o panorama na hora.",
  ].join("\n");
  await whatsapp.sendText({ to: telefone, text: msgFalha });
  return { success: false, userId: user.id, erro: "onboarding finalizado (falha fixa)" };
}

export async function handleOnboardingFixaDia(
  user: UserRow, telefone: string, texto: string, txIdsRaw: unknown
): Promise<ProcessResult> {
  type Payload = { titulo: string; valor: number };
  const data = (txIdsRaw ?? {}) as Payload;
  const m = texto.trim().match(/^(\d{1,2})/);
  const dia = m ? parseInt(m[1], 10) : NaN;
  if (isNaN(dia) || dia < 1 || dia > 31) {
    await whatsapp.sendText({ to: telefone, text: "Só o número do dia (1 a 31) 🙂\n💡 _Ex: 5_" });
    return { success: false, userId: user.id, erro: "onboarding fixa dia invalido" };
  }
  const diaClamp = Math.min(dia, 28);

  let novoLembrete: { id: number; titulo: string; valor: number; dia_vencimento: number } | null = null;
  try {
    const ins = await pool.query<{ id: number; titulo: string; valor: string; dia_vencimento: number }>(
      `INSERT INTO lembretes (user_id, titulo, valor, dia_vencimento, fixa, proxima_data, status, ultimo_aviso_em)
       SELECT $1::int, $2::text, $3::numeric, $4::int, TRUE,
              (
                CASE
                  WHEN $4::int >= EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int
                  THEN make_date(
                    EXTRACT(YEAR  FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int,
                    EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int,
                    $4::int
                  )
                  ELSE ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '1 month')::date
                END
              ),
              'pendente',
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
       WHERE NOT EXISTS (
         SELECT 1 FROM lembretes
         WHERE user_id = $1::int AND LOWER(titulo) = LOWER($2::text) AND fixa = TRUE AND status = 'pendente'
       )
       RETURNING id, titulo, valor, dia_vencimento`,
      [user.id, data.titulo, data.valor, diaClamp]
    );
    if (ins.rows[0]) {
      novoLembrete = {
        id:             ins.rows[0].id,
        titulo:         ins.rows[0].titulo,
        valor:          Number(ins.rows[0].valor),
        dia_vencimento: ins.rows[0].dia_vencimento,
      };
    }
  } catch (e) {
    log.error("erro ao inserir lembrete no onboarding (passo dia)", e);
  }

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  if (!novoLembrete) {
    await whatsapp.sendText({ to: telefone, text: `${capitalizeFirst(data.titulo)} já está nas suas contas fixas 🙂` });
    return { success: false, userId: user.id, erro: "lembrete já existe" };
  }

  await whatsapp.sendText({
    to:   telefone,
    text: `✅ *${capitalizeFirst(novoLembrete.titulo)}* anotado — ${fmtValor(novoLembrete.valor)}, todo dia ${novoLembrete.dia_vencimento}.\nTe aviso antes do vencimento 💪\n\nTem mais conta fixa? Manda do mesmo jeito.\nOu manda *pronto* pra começar a anotar gastos do dia.`,
  });
  return { success: false, userId: user.id, erro: "onboarding fixa solo concluído" };
}

function capitalizeFirst(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export async function handleNovoMesRenda(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("novo_mes renda recebida", { userId: user.id, texto });

  const valor = parseValor(texto.replace(/R\$\s*/i, "").trim());

  if (isNaN(valor) || valor <= 0) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\n3500" });
    return { success: false, userId: user.id, erro: "Valor inválido para renda" };
  }

  const now       = new Date();
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const meses     = ["janeiro","fevereiro","março","abril","maio","junho",
                     "julho","agosto","setembro","outubro","novembro","dezembro"];
  const mesPrev   = meses[prevStart.getUTCMonth()];
  const mesAtual  = meses[now.getUTCMonth()];

  // Calcula saldo do mês anterior ANTES de atualizar users.renda
  const metrics       = await fetchPeriodMetrics(user.id, prevStart, prevEnd);
  const rendaAnterior = Number(user.renda ?? 0) + Number(user.renda_extra ?? 0);
  const saldoPrev     = rendaAnterior + metrics.total_entradas - metrics.total_saidas;

  // Atualiza renda para o novo mês
  await pool.query(`UPDATE users SET renda = $1 WHERE id = $2`, [valor, user.id]);

  let resposta: string;

  if (saldoPrev > 0.01) {
    // Guarda saldo em centavos no pending para a próxima etapa
    await pool.query(
      `UPDATE pending_actions
       SET step = 'waiting_carryover',
           tx_ids = $1::jsonb,
           expires_at = NOW() + INTERVAL '24 hours'
       WHERE user_id = $2`,
      [JSON.stringify({ saldo_centavos: Math.round(saldoPrev * 100) }), user.id]
    );
    resposta = [
      "💰 Renda registrada.",
      "",
      `Você terminou ${mesPrev} com:`,
      `+${fmtValor(saldoPrev)}`,
      "",
      `Deseja levar esse saldo para ${mesAtual}?`,
      "",
      "1️⃣ Sim",
      "2️⃣ Não",
    ].join("\n");
  } else {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    resposta = saldoPrev < -0.01
      ? `💰 Renda registrada.\n\n${mesPrev.charAt(0).toUpperCase() + mesPrev.slice(1)} fechou no vermelho.`
      : `💰 Renda registrada.`;
  }

  await whatsapp.sendText({ to: telefone, text: resposta });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "novo_mes_renda", valor } };
}

export async function handleNovoMesCarryover(
  user: UserRow, telefone: string, escolha: string, txIdsRaw: unknown
): Promise<ProcessResult> {
  log.webhook("novo_mes carryover", { userId: user.id, escolha });

  const saldo = ((txIdsRaw as { saldo_centavos?: number })?.saldo_centavos ?? 0) / 100;
  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  let msg: string;
  if (escolha === "1" && saldo > 0) {
    await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'entrada', $2, 'Outros', 'saldo anterior')`,
      [user.id, saldo]
    );
    msg = `✅ ${fmtValor(saldo)} do mês passado adicionados ao saldo. 💰`;
  } else {
    msg = "✅ Ok! Começando o mês do zero. 🚀";
  }

  await whatsapp.sendText({ to: telefone, text: msg });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "novo_mes_carryover", escolha } };
}
