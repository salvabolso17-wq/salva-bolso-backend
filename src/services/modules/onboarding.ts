import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor } from "../../utils/formatting";
import { fetchPeriodMetrics } from "../reportService";
import { parseValor, parseTransaction } from "../../utils/parseTransaction";
import type { UserRow, ProcessResult } from "../types";

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
      "Sem problemas! Você pode informar sua renda depois mandando: 'recebo 3000'.",
      "",
      "E você tem alguma conta fixa mensal? (Aluguel, luz, internet, etc)",
      "",
      "Se tiver, me manda uma agora para eu lembrar você:",
      "Ex: aluguel 1200",
      "",
      "Ou mande 'pular' para começar a usar."
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

    await whatsapp.sendText({ to: telefone, text: "Não entendi o valor 🤔\nEx: 3500 ou 'pular'" });
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
    `💰 Boa! Renda de ${fmtValor(valor)} registrada.`,
    "",
    "Você tem alguma conta fixa mensal? (Aluguel, luz, internet, celular...)",
    "",
    "Me manda a principal:",
    "Ex: aluguel 1200",
    "",
    "Ou mande 'pular'."
  ].join("\n");

  await whatsapp.sendText({ to: telefone, text: msg });
  return { success: false, userId: user.id, erro: "onboarding fixas_ask" };
}

export async function handleOnboardingFixas(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  const textoTrim = texto.trim();
  const skipFixas = /^(n[aã]o|pula|pular|depois|n[aã]o\s+quero|ignore|ignora|skip|nada)[\?!.]*$/i.test(textoTrim);

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  if (skipFixas) {
    const msg = [
      "Tudo pronto! 🚀",
      "",
      "Sempre que gastar algo, é só me mandar:",
      "50 mercado  •  35 uber  •  120 farmácia",
      "",
      "Pode mandar o seu primeiro gasto!"
    ].join("\n");
    await whatsapp.sendText({ to: telefone, text: msg });
    return { success: false, userId: user.id, erro: "onboarding finalizado (skip fixas)" };
  }

  // Tenta parsear como uma despesa. Se der certo, nós já guardamos como recorrente.
  const parsed = parseTransaction(textoTrim);
  if (parsed && parsed.tipo === "saida") {
    // Insere como recorrente
    const descricao = parsed.descricao || "conta fixa";
    await pool.query(
      `INSERT INTO recurrings (user_id, tipo, valor, categoria, descricao, dia_vencimento)
       VALUES ($1, 'saida', $2, $3, $4, 10)`, // Chutando dia 10 como default para o onboarding
      [user.id, parsed.valor, parsed.categoria || 'Outros', descricao]
    );

    const msg = [
      `✅ Perfeito! Salvei ${capitalizeFirst(descricao)} (${fmtValor(parsed.valor)}) como conta fixa.`,
      "",
      "Sua configuração está completa 🚀",
      "",
      "Agora, o Salva Bolso é seu bloco de notas inteligente. Quando gastar, me manda:",
      "Ex: 50 mercado",
      "",
      "Tenta lançar seu primeiro gasto de hoje!"
    ].join("\n");
    await whatsapp.sendText({ to: telefone, text: msg });
    return { success: false, userId: user.id, erro: "onboarding finalizado (com fixa)" };
  }

  // Se não conseguir parsear, apenas finaliza
  const msgFalha = [
    "Não consegui identificar o valor, mas não tem problema. Você pode adicionar depois mandando: 'recorrente 1200 aluguel'.",
    "",
    "Sua configuração está completa 🚀",
    "",
    "Sempre que gastar algo, me manda:",
    "50 mercado  •  35 uber"
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
