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
      "Sem problemas! ⏭️ Você pode informar sua renda depois mandando: _'recebo 3000'_.",
      "",
      "E você tem alguma *conta fixa mensal*? 📅 (Aluguel, luz, internet, etc)",
      "",
      "Se tiver, me manda a principal para eu já deixar agendada:",
      "💡 _Ex: aluguel 1200_",
      "",
      "_(Ou mande 'pular' para começar a usar 🚀)_"
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
    `💰 Boa! Renda de *${fmtValor(valor)}* registrada com sucesso.`,
    "",
    "Agora, você tem alguma *conta fixa mensal*? 📅 (Aluguel, luz, internet, celular...)",
    "",
    "Me manda a principal para eu já deixar agendada:",
    "💡 _Ex: aluguel 1200_",
    "",
    "_(Ou mande 'pular' ⏭️)_"
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
      `💰 Tua renda registrada: ${fmtValor(renda)}`,
      "",
      "Agora me manda o primeiro gasto de hoje pra eu te mostrar como categorizo:",
      "🛒 _50 mercado_ • 🚗 _35 uber_ • 💊 _120 farmácia_",
      "",
      "Conforme você for usando, vou montando teu painel financeiro automaticamente.",
    ].join("\n");
    await whatsapp.sendText({ to: telefone, text: msg });
    return { success: false, userId: user.id, erro: "onboarding finalizado (skip fixas)" };
  }

  // Tenta parsear como uma despesa. Se der certo, nós já guardamos como recorrente.
  const parsed = parseTransaction(textoTrim);
  if (parsed && parsed.tipo === "saida") {
    // Insere como lembrete fixo (dia=hoje BRT, próximo mês). Usuário pode reajustar com "muda X pra dia Y".
    const descricao = parsed.descricao || "conta fixa";
    try {
      await pool.query(
        `INSERT INTO lembretes (user_id, titulo, valor, dia_vencimento, fixa, proxima_data, status, ultimo_aviso_em)
         SELECT $1, $2, $3,
                LEAST(EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int, 28),
                TRUE,
                ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '1 month')::date,
                'pendente',
                (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
         WHERE NOT EXISTS (
           SELECT 1 FROM lembretes
           WHERE user_id = $1 AND LOWER(titulo) = LOWER($2) AND fixa = TRUE AND status = 'pendente'
         )`,
        [user.id, descricao, parsed.valor]
      );
    } catch (e) {
      log.error("erro ao inserir lembrete no onboarding", e);
    }

    try {
      await pool.query(
        `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
         VALUES ($1, 'saida', $2, 'Moradia', $3)`,
        [user.id, parsed.valor, descricao]
      );
    } catch (e) {
      log.error("erro ao inserir transaction da conta fixa no onboarding", e);
    }

    const renda      = Number(user.renda ?? 0);
    const totalFixas = await somaContasFixas(user.id);
    const sobra      = renda - totalFixas;

    const msg = [
      `✅ Conta fixa salva: *${capitalizeFirst(descricao)}* (${fmtValor(parsed.valor)})`,
      "",
      "Já consigo te mostrar uma coisa importante:",
      "",
      `💰 Renda: ${fmtValor(renda)}`,
      `🏠 Contas fixas: ${fmtValor(totalFixas)}`,
      "──────────",
      `📊 *Sobra pro mês: ${fmtValor(sobra)}*`,
      "",
      "Isso é o que você tem pra dividir entre comida, lazer, transporte e o resto. Vou te ajudar a fazer render.",
      "",
      "Agora manda seu primeiro gasto de hoje pra eu te mostrar como categorizo na hora:",
      "🛒 _50 mercado_ • 🚗 _35 uber_ • 💊 _120 farmácia_",
    ].join("\n");
    await whatsapp.sendText({ to: telefone, text: msg });
    return { success: false, userId: user.id, erro: "onboarding finalizado (com fixa)" };
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
