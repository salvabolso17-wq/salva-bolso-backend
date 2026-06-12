import Anthropic from "@anthropic-ai/sdk";
import { log } from "../../utils/logger";
import { isCuriosityPhrase } from "./menuBuilder";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VALID_COMMANDS = [
  "saldo", "resumo", "recorrentes", "hoje", "semana",
  "ranking", "metas", "extrato", "ajuda", "proximas",
  "comparar", "top_gastos", "desafio", "previsao", "categorias",
  "editar_recorrente", "apagar_recorrente", "pagar_recorrente"
] as const;

type BotCommand = typeof VALID_COMMANDS[number];

const SYSTEM_PROMPT = `Você é um classificador de intenção para um assistente financeiro no WhatsApp chamado Salva Bolso.

Dado uma mensagem do usuário, responda APENAS com o nome do comando mais adequado, sem explicações.

Comandos:
- saldo: saldo do mês, quanto sobrou, quanto tenho disponível
- resumo: gastos por categoria, relatório do mês, quanto gastei
- recorrentes: contas fixas, assinaturas, recorrentes, contas mensais
- hoje: gastos de hoje
- semana: gastos da semana, últimos 7 dias
- ranking: onde gasto mais, maiores categorias
- metas: metas de poupança, objetivos, quanto juntei
- extrato: histórico, extrato, lançamentos do mês
- ajuda: como funciona, o que pode fazer, menu, comandos
- proximas: próximas contas, o que vence
- comparar: comparar com mês passado
- top_gastos: maiores gastos, top 5
- desafio: desafio de economia
- previsao: previsão do mês, estimativa
- categorias: listar categorias
- editar_recorrente: mudar o valor de uma conta fixa ("aluguel subiu para 1300", "netflix agora é 45", "mudar internet para 150", "atualizar luz para 200")
- apagar_recorrente: cancelar ou remover uma conta fixa ("cancelei a netflix", "não tenho mais internet", "remover o aluguel", "parei de pagar academia")
- pagar_recorrente: registrar que pagou uma conta fixa ("já paguei o aluguel", "paguei a netflix", "quitei a internet", "aluguel pago")
- unknown: pedidos de lembrete ("pode lembrar", "me avisa", "me lembra"), agendamentos, notificações, funcionalidades não disponíveis, conversas pessoais

Responda APENAS com o nome do comando. Nada mais.`;

const FALLBACK_SYSTEM = `Você é o Salva Bolso, assistente financeiro no WhatsApp. O usuário mandou uma mensagem que você não reconheceu. Responda em 1 ou 2 linhas, em português informal, orientando gentilmente. Não invente comandos. Exemplos do que funciona: registrar gastos (50 mercado), ver saldo, resumo, metas, recorrentes.`;

export async function generateFallbackReply(texto: string): Promise<string> {
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      system: FALLBACK_SYSTEM,
      messages: [{ role: "user", content: texto }],
    });
    const reply = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    return reply || "Não entendi. Pode mandar um gasto (ex: 50 mercado) ou pedir o resumo do mês.";
  } catch (err) {
    log.error("generateFallbackReply falhou", err);
    return "Não entendi. Pode mandar um gasto (ex: 50 mercado) ou pedir o resumo do mês.";
  }
}

export async function isCuriosityPhraseAI(texto: string): Promise<boolean> {
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 5,
      system: "Você decide se uma mensagem é uma pergunta de curiosidade sobre o que o assistente financeiro Salva Bolso pode fazer — sem ser um comando direto (saldo, resumo, metas, etc) nem registro de gasto. Responda apenas: sim ou nao.",
      messages: [{ role: "user", content: texto }],
    });
    const text = response.content[0]?.type === "text"
      ? response.content[0].text.trim().toLowerCase()
      : "";
    return text.startsWith("sim");
  } catch (err) {
    log.error("isCuriosityPhraseAI falhou", err);
    return isCuriosityPhrase(texto);
  }
}

export async function classifyIntentWithAI(texto: string, lastCommand = "", recentActions: string[] = []): Promise<BotCommand | null> {
  try {
    const contexto = recentActions.length > 0
      ? `Ações recentes do usuário: ${recentActions.slice(0, 3).join(", ")}\n`
      : "";
    const userContent = lastCommand
      ? `${contexto}Último comando: ${lastCommand}\nMensagem: ${texto}`
      : contexto
        ? `${contexto}Mensagem: ${texto}`
        : texto;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 20,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }] as Anthropic.Messages.TextBlockParam[],
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content[0]?.type === "text"
      ? response.content[0].text.trim().toLowerCase()
      : "";

    if ((VALID_COMMANDS as readonly string[]).includes(text) && text !== "unknown") {
      return text as BotCommand;
    }
    return null;
  } catch (err) {
    log.error("classifyIntentWithAI falhou", err);
    return null;
  }
}
