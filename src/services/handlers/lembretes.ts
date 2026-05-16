import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst } from "../../utils/formatting";
import { interpretarLembrete, interpretarLembreteComContexto, type LembreteIntencao } from "../modules/lembretesNLU";
import {
  criarLembrete,
  listarLembretesParaTela,
  buscarLembretesPorTitulo,
  getLembrete,
  marcarPago,
  cancelarLembrete,
  editarLembrete,
  diasAteVencimento,
  dataToISO,
  type LembreteRow,
} from "../modules/lembretes";
import type { UserRow, ProcessResult } from "../types";

const FLUXO_CRIAR        = "lembrete_criar";
const FLUXO_PAGAR_PICK   = "lembrete_pagar_pick";
const FLUXO_CANCELAR     = "lembrete_cancelar_confirm";
const FLUXO_CANCELAR_PICK= "lembrete_cancelar_pick";
const FLUXO_EDITAR_PICK  = "lembrete_editar_pick";

interface CriarState {
  titulo?: string;
  valor?: number;
  dia?: number;
  fixa?: boolean;
}

interface PickState {
  ids: number[];
  acao: "pagar" | "cancelar" | "editar";
  patch?: { titulo?: string; valor?: number; dia?: number; fixa?: boolean };
}

interface CancelarConfirmState {
  id: number;
  titulo: string;
}

interface CtxRow {
  user_id: number;
  fluxo: string;
  dados: unknown;
  expira_em: Date;
}

async function getContext(userId: number): Promise<CtxRow | null> {
  try {
    const r = await pool.query<CtxRow>(
      `SELECT user_id, fluxo, dados, expira_em
       FROM conversation_context
       WHERE user_id = $1 AND expira_em > NOW()`,
      [userId],
    );
    return r.rows[0] ?? null;
  } catch (err) {
    log.error("getContext falhou", err, { userId });
    return null;
  }
}

async function setContext(userId: number, fluxo: string, dados: unknown, ttlMinutes = 15): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO conversation_context (user_id, fluxo, dados, expira_em, atualizado_em)
       VALUES ($1, $2, $3::jsonb, NOW() + ($4 || ' minutes')::interval, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET fluxo = $2, dados = $3::jsonb,
             expira_em = NOW() + ($4 || ' minutes')::interval,
             atualizado_em = NOW()`,
      [userId, fluxo, JSON.stringify(dados ?? {}), String(ttlMinutes)],
    );
  } catch (err) {
    log.error("setContext falhou", err, { userId, fluxo });
  }
}

async function clearContext(userId: number): Promise<void> {
  try {
    await pool.query(`DELETE FROM conversation_context WHERE user_id = $1`, [userId]);
  } catch (err) {
    log.error("clearContext falhou", err, { userId });
  }
}

async function send(telefone: string, text: string): Promise<void> {
  try {
    await whatsapp.sendText({ to: telefone, text });
  } catch (err) {
    log.error("falha envio lembrete", err, { to: telefone });
  }
}

function isAffirmative(t: string): boolean {
  return /^(sim|s|claro|isso|exato|pode|quero|ok|beleza|certo|perfeito|t[aá]|tá|aham|uhum|yes)[\?!.]*$/i.test(t.trim());
}

function isNegative(t: string): boolean {
  return /^(n[aã]o|nao|n|nope|cancela|cancelar|deixa|deixa\s+pra\s+l[aá]|nada)[\?!.]*$/i.test(t.trim());
}

function extrairDia(t: string): number | undefined {
  const m = t.match(/^(\d{1,2})$/) || t.match(/dia\s+(\d{1,2})/i) || t.match(/(\d{1,2})/);
  if (m) {
    const d = parseInt(m[1], 10);
    if (d >= 1 && d <= 31) return d;
  }
  return undefined;
}

function extrairFixaLivre(t: string): boolean | undefined {
  const tl = t.toLowerCase().trim();
  if (/\b(fixa|fixo|mensal|todo\s+m[eê]s|sempre|recorrente|sim)\b/.test(tl)) return true;
  if (/\b(uma\s+vez|s[oó]\s+(esse|este)\s+m[eê]s|pontual|n[aã]o|esse\s+m[eê]s)\b/.test(tl)) return false;
  return undefined;
}

function extrairTituloValorLivre(t: string): { titulo?: string; valor?: number } {
  // "netflix 45" / "Aluguel de R$ 1.200"
  const valMatch = t.match(/r\$\s*([\d.,]+)/i) || t.match(/\b([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\b/);
  let valor: number | undefined;
  if (valMatch) {
    let s = valMatch[1];
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/[.,]/g, "");
    const n = parseFloat(s);
    if (!isNaN(n) && n > 0) valor = n;
  }
  const titulo = t
    .replace(/r\$\s*[\d.,]+/gi, " ")
    .replace(/\b\d[\d.,]*\b/g, " ")
    .replace(/\b(de|do|da|a|o|os|as|pra|para|com|reais?|conto[s]?)\b/gi, " ")
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { titulo: titulo || undefined, valor };
}

function pickEscolha(t: string, max: number): number | null {
  const m = t.match(/^(\d+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= max) return n;
  }
  if (/^(primeir[ao]|1[aoª°]?)$/i.test(t.trim())) return 1;
  if (/^(segund[ao]|2[aoª°]?)$/i.test(t.trim())) return 2;
  if (/^(terceir[ao]|3[aoª°]?)$/i.test(t.trim())) return 3;
  return null;
}

async function avancarCriar(user: UserRow, telefone: string, state: CriarState): Promise<ProcessResult> {
  log.webhook("lembrete: avancarCriar", { userId: user.id, state, callstack: (new Error().stack ?? "").split("\n").slice(2, 4).join(" ← ") });

  // Reusar valor já conhecido (evita perguntar de novo se Spotify/Aluguel já existe)
  if (state.titulo && !state.valor) {
    const existentes = await buscarLembretesPorTitulo(user.id, state.titulo);
    if (existentes.length > 0) {
      state.valor = Number(existentes[0].valor);
    } else {
      const r = await pool.query<{ valor: string }>(
        `SELECT valor FROM transactions
         WHERE user_id = $1
           AND tipo = 'saida'
           AND LOWER(descricao) LIKE $2
           AND criado_em >= NOW() - INTERVAL '30 days'
         ORDER BY criado_em DESC LIMIT 1`,
        [user.id, `%${state.titulo.toLowerCase()}%`],
      );
      if (r.rows[0]) state.valor = Number(r.rows[0].valor);
    }
  }

  if (!state.titulo) {
    await setContext(user.id, FLUXO_CRIAR, state);
    await send(telefone, "Boa, vamos lá. Me conta o nome da conta e o valor.\n(ex: \"Luz, 180\" ou \"Aluguel de R$ 1.200\")");
    return { success: false, userId: user.id, erro: "lembrete_criar aguardando titulo/valor" };
  }
  if (!state.valor) {
    await setContext(user.id, FLUXO_CRIAR, state);
    await send(telefone, `Beleza, ${capitalizeFirst(state.titulo)}. Qual o valor?`);
    return { success: false, userId: user.id, erro: "lembrete_criar aguardando valor" };
  }
  if (!state.dia) {
    await setContext(user.id, FLUXO_CRIAR, state);
    await send(telefone, `Show. Que dia do mês vence?`);
    return { success: false, userId: user.id, erro: "lembrete_criar aguardando dia" };
  }
  if (state.fixa === undefined) {
    await setContext(user.id, FLUXO_CRIAR, state);
    await send(telefone, `E é uma conta que vem todo mês ou só dessa vez?`);
    return { success: false, userId: user.id, erro: "lembrete_criar aguardando fixa" };
  }

  // Tudo preenchido → cria
  try {
    const l = await criarLembrete(user.id, state.titulo, state.valor, state.dia, state.fixa);
    await clearContext(user.id);
    log.webhook("lembrete criado", { userId: user.id, lembreteId: l.id, titulo: l.titulo, valor: state.valor, dia: state.dia, fixa: state.fixa });
    if (l.status === 'pago') {
      const proxMes = ((new Date().getMonth() + 1) % 12) + 1;
      await send(
        telefone,
        `📌 ${capitalizeFirst(l.titulo)} salvo nas contas fixas.\nO desse mês já tá pago (você anotou agora). Próximo lembrete: dia ${l.dia_vencimento}/${proxMes} ✅`,
      );
    } else {
      const tipo = l.fixa ? "conta fixa" : "pontual";
      await send(
        telefone,
        `📌 Lembrete criado:\n${capitalizeFirst(l.titulo)} · ${fmtValor(Number(l.valor))} · todo dia ${l.dia_vencimento} · ${tipo}\nVou te avisar 3, 2 e 1 dia antes do vencimento.`,
      );
    }
    return { success: true, userId: user.id, transacao: { id: l.id }, interpretado: { comando: "lembrete_criar" } };
  } catch (err) {
    log.error("falha criarLembrete", err, { userId: user.id });
    await send(telefone, "Não consegui salvar o lembrete agora. Tenta de novo em alguns segundos 🙂");
    return { success: false, userId: user.id, erro: "criarLembrete falhou" };
  }
}

function fmtValorBR(n: number): string {
  const decimais = n % 1 === 0 ? 0 : 2;
  return "R$ " + n.toLocaleString("pt-BR", { minimumFractionDigits: decimais, maximumFractionDigits: 2 });
}

function linhaItemLembrete(l: LembreteRow): string {
  const dias = diasAteVencimento(l.proxima_data);
  const v    = fmtValorBR(Number(l.valor));
  const t    = capitalizeFirst(l.titulo);
  const dia  = l.dia_vencimento;
  if (dias <= -30) {
    const m = Math.round(Math.abs(dias) / 30);
    return `${t} · ${v} · venceu há ~${m} ${m === 1 ? "mês" : "meses"}`;
  }
  if (dias < 0) {
    const n = Math.abs(dias);
    return `${t} · ${v} · venceu há ${n} dia${n > 1 ? "s" : ""}`;
  }
  if (dias === 0) return `${t} · ${v} · hoje (dia ${dia})`;
  if (dias === 1) return `${t} · ${v} · amanhã`;
  if (dias <= 7)  return `${t} · ${v} · em ${dias} dias (dia ${dia})`;
  if (dias < 30)  return `${t} · ${v} · em ${dias} dias`;
  const m = Math.round(dias / 30);
  return `${t} · ${v} · em ~${m} ${m === 1 ? "mês" : "meses"}`;
}

async function listarHandler(user: UserRow, telefone: string): Promise<ProcessResult> {
  try {
    log.webhook("lembrete: listarHandler", { userId: user.id });
    const { pendentes, pagosMes } = await listarLembretesParaTela(user.id);
    log.webhook("lembrete: listarHandler resultado", {
      userId: user.id,
      pendentes: pendentes.length,
      pagosMes:  pagosMes.length,
      idsPend:   pendentes.map(x => x.id),
      idsPagos:  pagosMes.map(x => x.id),
    });

    // Vazio total: nenhuma conta cadastrada
    if (pendentes.length === 0 && pagosMes.length === 0) {
      await send(
        telefone,
        '🍃 Você não tem nenhuma conta cadastrada.\n\nQuer começar? Manda algo como:\n"lembra de pagar luz dia 10, 180 reais, todo mês"',
      );
      return { success: false, userId: user.id, erro: "lembretes vazios" };
    }

    // Só pagos: tudo em dia esse mês
    if (pendentes.length === 0 && pagosMes.length > 0) {
      const totalPago = pagosMes.reduce((s, l) => s + Number(l.valor), 0);
      await send(
        telefone,
        `✅ Tudo em dia esse mês!\n\nJá pago: ${fmtValorBR(totalPago)}\nNada pendente. Bom trabalho 👏`,
      );
      return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "lembrete_listar_em_dia" } };
    }

    // Agrupa pendentes por urgência
    const atrasadas: LembreteRow[] = [];
    const hoje:      LembreteRow[] = [];
    const semana:    LembreteRow[] = [];
    const depois:    LembreteRow[] = [];
    for (const l of pendentes) {
      const d = diasAteVencimento(l.proxima_data);
      if (d < 0)       atrasadas.push(l);
      else if (d === 0) hoje.push(l);
      else if (d <= 7)  semana.push(l);
      else              depois.push(l);
    }

    const linhas: string[] = ["📋 Suas contas", ""];
    const pushGrupo = (titulo: string, items: LembreteRow[]) => {
      if (items.length === 0) return;
      linhas.push(`${titulo} (${items.length})`);
      for (const l of items) linhas.push("   " + linhaItemLembrete(l));
      linhas.push("");
    };
    pushGrupo("🚨 ATRASADAS",     atrasadas);
    pushGrupo("⏰ VENCE HOJE",    hoje);
    pushGrupo("📅 ESSA SEMANA",   semana);
    pushGrupo("🗓️ PRÓXIMOS DIAS", depois);

    const totalPagar = pendentes.reduce((s, l) => s + Number(l.valor), 0);
    const totalPago  = pagosMes.reduce((s, l) => s + Number(l.valor), 0);

    linhas.push("──────────");
    linhas.push(`💰 A pagar: ${fmtValorBR(totalPagar)}`);
    if (totalPago > 0) linhas.push(`✅ Já pago esse mês: ${fmtValorBR(totalPago)}`);

    await send(telefone, linhas.join("\n"));
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "lembrete_listar" } };
  } catch (err) {
    log.error("falha listar lembretes", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "listar falhou" };
  }
}

async function pagarHandler(user: UserRow, telefone: string, titulo?: string): Promise<ProcessResult> {
  if (!titulo) {
    log.webhook("lembrete: pagar sem titulo", { userId: user.id });
    await send(telefone, "Qual conta foi paga? (ex: \"paguei a luz\")");
    return { success: false, userId: user.id, erro: "pagar sem titulo" };
  }
  const candidatos = (await buscarLembretesPorTitulo(user.id, titulo)).filter(l => l.status === "pendente");
  log.webhook("lembrete: pagar busca", { userId: user.id, titulo, encontrados: candidatos.length });
  if (candidatos.length === 0) {
    await send(telefone, `Não achei nenhum lembrete com "${titulo}".`);
    return { success: false, userId: user.id, erro: "pagar nao encontrado" };
  }
  if (candidatos.length === 1) {
    return await aplicarPagar(user, telefone, candidatos[0]);
  }
  // Ambíguo: pede seleção
  const linhas = candidatos.slice(0, 9).map((l, i) => `${i + 1}️⃣ ${capitalizeFirst(l.titulo)} (${fmtValor(Number(l.valor))})`);
  await setContext(user.id, FLUXO_PAGAR_PICK, { ids: candidatos.slice(0, 9).map(l => l.id), acao: "pagar" } as PickState);
  await send(telefone, `Tem ${candidatos.length} contas parecidas. Qual delas?\n${linhas.join("\n")}`);
  return { success: false, userId: user.id, erro: "pagar ambiguo" };
}

async function aplicarPagar(user: UserRow, telefone: string, l: LembreteRow): Promise<ProcessResult> {
  try {
    const r = await marcarPago(user.id, l.id);
    if (!r) {
      await send(telefone, "Esse lembrete já tinha sido pago ou cancelado.");
      return { success: false, userId: user.id, erro: "marcarPago no-op" };
    }
    log.webhook("lembrete: pagar aplicado", { userId: user.id, lembreteId: l.id, fixa: r.pago.fixa, proximoId: r.proximo?.id ?? null });
    if (r.proximo) {
      const proxDia = r.proximo.dia_vencimento;
      const proxMes = new Date(dataToISO(r.proximo.proxima_data) + "T00:00:00Z").toLocaleString("pt-BR", { month: "long", timeZone: "UTC" });
      await send(telefone, `✅ Marquei o pagamento de *${capitalizeFirst(r.pago.titulo)}*.\nPróximo lembrete: dia ${proxDia} de ${proxMes}.`);
    } else {
      await send(telefone, `✅ Marquei o pagamento de *${capitalizeFirst(r.pago.titulo)}*.`);
    }
    return { success: true, userId: user.id, transacao: { id: r.pago.id }, interpretado: { comando: "lembrete_pagar" } };
  } catch (err) {
    log.error("falha aplicar pagar", err, { userId: user.id, id: l.id });
    return { success: false, userId: user.id, erro: "pagar falhou" };
  }
}

async function cancelarHandler(user: UserRow, telefone: string, titulo?: string): Promise<ProcessResult> {
  if (!titulo) {
    await send(telefone, "Qual lembrete você quer remover?");
    return { success: false, userId: user.id, erro: "cancelar sem titulo" };
  }
  const candidatos = (await buscarLembretesPorTitulo(user.id, titulo)).filter(l => l.status !== "cancelado");
  if (candidatos.length === 0) {
    await send(telefone, `Não achei nenhum lembrete com "${titulo}".`);
    return { success: false, userId: user.id, erro: "cancelar nao encontrado" };
  }
  if (candidatos.length === 1) {
    const alvo = candidatos[0];
    await setContext(user.id, FLUXO_CANCELAR, { id: alvo.id, titulo: alvo.titulo } as CancelarConfirmState);
    await send(telefone, `Tem certeza que quer remover o lembrete de ${capitalizeFirst(alvo.titulo)}? (sim/não)`);
    return { success: false, userId: user.id, erro: "cancelar aguardando confirmacao" };
  }
  const linhas = candidatos.slice(0, 9).map((l, i) => `${i + 1}️⃣ ${capitalizeFirst(l.titulo)} (${fmtValor(Number(l.valor))})`);
  await setContext(user.id, FLUXO_CANCELAR_PICK, { ids: candidatos.slice(0, 9).map(l => l.id), acao: "cancelar" } as PickState);
  await send(telefone, `Tem ${candidatos.length} parecidas. Qual remover?\n${linhas.join("\n")}`);
  return { success: false, userId: user.id, erro: "cancelar ambiguo" };
}

async function editarHandler(user: UserRow, telefone: string, intencao: LembreteIntencao): Promise<ProcessResult> {
  const titulo = intencao.dados.titulo;
  if (!titulo) {
    await send(telefone, "Qual conta quer editar?");
    return { success: false, userId: user.id, erro: "editar sem titulo" };
  }
  const candidatos = (await buscarLembretesPorTitulo(user.id, titulo)).filter(l => l.status !== "cancelado");
  if (candidatos.length === 0) {
    await send(telefone, `Não achei nenhum lembrete com "${titulo}".`);
    return { success: false, userId: user.id, erro: "editar nao encontrado" };
  }
  const patch = { valor: intencao.dados.valor, dia: intencao.dados.dia, fixa: intencao.dados.fixa };
  if (candidatos.length === 1) {
    return await aplicarEditar(user, telefone, candidatos[0], patch);
  }
  const linhas = candidatos.slice(0, 9).map((l, i) => `${i + 1}️⃣ ${capitalizeFirst(l.titulo)} (${fmtValor(Number(l.valor))})`);
  await setContext(user.id, FLUXO_EDITAR_PICK, { ids: candidatos.slice(0, 9).map(l => l.id), acao: "editar", patch } as PickState);
  await send(telefone, `Tem ${candidatos.length} parecidas. Qual editar?\n${linhas.join("\n")}`);
  return { success: false, userId: user.id, erro: "editar ambiguo" };
}

async function aplicarEditar(
  user: UserRow,
  telefone: string,
  l: LembreteRow,
  patch: { valor?: number; dia?: number; fixa?: boolean; titulo?: string },
): Promise<ProcessResult> {
  try {
    const r = await editarLembrete(user.id, l.id, patch);
    if (!r) {
      await send(telefone, "Não consegui atualizar agora.");
      return { success: false, userId: user.id, erro: "editar falhou" };
    }
    const partes: string[] = [];
    if (patch.dia !== undefined)   partes.push(`vence dia ${patch.dia}`);
    if (patch.valor !== undefined) partes.push(`valor ${fmtValor(patch.valor)}`);
    if (patch.fixa !== undefined)  partes.push(patch.fixa ? "fixa todo mês" : "pontual");
    const detalhe = partes.length ? `: ${capitalizeFirst(l.titulo)} agora ${partes.join(", ")}` : "";
    await send(telefone, `✅ Atualizado${detalhe}.`);
    return { success: true, userId: user.id, transacao: { id: r.id }, interpretado: { comando: "lembrete_editar" } };
  } catch (err) {
    log.error("falha aplicar editar", err, { userId: user.id, id: l.id });
    return { success: false, userId: user.id, erro: "editar falhou" };
  }
}

async function continuarFluxo(user: UserRow, telefone: string, texto: string, ctx: CtxRow): Promise<ProcessResult> {
  const t = texto.trim();

  if (/^cancelar$/i.test(t) || /^esquece(\s+isso)?$/i.test(t)) {
    await clearContext(user.id);
    await send(telefone, "Ok, deixei pra lá.");
    return { success: false, userId: user.id, erro: "fluxo lembrete cancelado" };
  }

  if (ctx.fluxo === FLUXO_CRIAR) {
    const state = (ctx.dados ?? {}) as CriarState;

    // Passa pela NLU para extrair o que faltar
    const intencao = await interpretarLembrete(t);

    if (!state.titulo || !state.valor) {
      const { titulo, valor } = extrairTituloValorLivre(t);
      if (titulo && !state.titulo) state.titulo = titulo;
      if (valor  && !state.valor)  state.valor  = valor;
      if (intencao.dados.titulo && !state.titulo) state.titulo = intencao.dados.titulo;
      if (intencao.dados.valor  && !state.valor)  state.valor  = intencao.dados.valor;
    }
    if (!state.dia) {
      const d = extrairDia(t) ?? intencao.dados.dia;
      if (d) state.dia = d;
    }
    if (state.fixa === undefined) {
      const f = extrairFixaLivre(t);
      if (f !== undefined) state.fixa = f;
      else if (intencao.dados.fixa !== undefined) state.fixa = intencao.dados.fixa;
    }
    return await avancarCriar(user, telefone, state);
  }

  if (ctx.fluxo === FLUXO_CANCELAR) {
    const st = ctx.dados as CancelarConfirmState;
    if (isAffirmative(t)) {
      const ok = await cancelarLembrete(user.id, st.id);
      await clearContext(user.id);
      if (ok) await send(telefone, `✅ Removido. Não vou mais te avisar.`);
      else    await send(telefone, `Não achei o lembrete pra remover.`);
      return { success: ok, userId: user.id, transacao: { id: st.id }, interpretado: { comando: "lembrete_cancelar" } } as ProcessResult;
    }
    if (isNegative(t)) {
      await clearContext(user.id);
      await send(telefone, "Beleza, mantive aqui.");
      return { success: false, userId: user.id, erro: "cancelar rejeitado" };
    }
    await send(telefone, "Responde com sim ou não 🙂");
    return { success: false, userId: user.id, erro: "cancelar aguardando" };
  }

  if (ctx.fluxo === FLUXO_PAGAR_PICK || ctx.fluxo === FLUXO_CANCELAR_PICK || ctx.fluxo === FLUXO_EDITAR_PICK) {
    const st = ctx.dados as PickState;
    const idx = pickEscolha(t, st.ids.length);
    if (idx === null) {
      // tentar match por "a de 180"
      const valMatch = t.match(/(\d+[.,]?\d*)/);
      if (valMatch) {
        const v = parseFloat(valMatch[1].replace(",", "."));
        // busca o id cujo valor mais próximo bate
        const r = await pool.query<LembreteRow>(
          `SELECT * FROM lembretes WHERE id = ANY($1::int[])`,
          [st.ids],
        );
        const found = r.rows.find(l => Math.abs(Number(l.valor) - v) < 0.5);
        if (found) {
          await clearContext(user.id);
          if (st.acao === "pagar")    return await aplicarPagar(user, telefone, found);
          if (st.acao === "cancelar") {
            await setContext(user.id, FLUXO_CANCELAR, { id: found.id, titulo: found.titulo } as CancelarConfirmState);
            await send(telefone, `Tem certeza que quer remover o lembrete de ${capitalizeFirst(found.titulo)}? (sim/não)`);
            return { success: false, userId: user.id, erro: "cancelar aguardando confirmacao" };
          }
          if (st.acao === "editar")   return await aplicarEditar(user, telefone, found, st.patch ?? {});
        }
      }
      await send(telefone, `Manda o número (1 a ${st.ids.length}) ou "cancelar".`);
      return { success: false, userId: user.id, erro: "pick invalido" };
    }
    const id = st.ids[idx - 1];
    const alvo = (await pool.query<LembreteRow>(`SELECT * FROM lembretes WHERE id = $1 AND user_id = $2`, [id, user.id])).rows[0];
    if (!alvo) {
      await clearContext(user.id);
      await send(telefone, "Esse lembrete não existe mais.");
      return { success: false, userId: user.id, erro: "pick inexistente" };
    }
    await clearContext(user.id);
    if (st.acao === "pagar")    return await aplicarPagar(user, telefone, alvo);
    if (st.acao === "cancelar") {
      await setContext(user.id, FLUXO_CANCELAR, { id: alvo.id, titulo: alvo.titulo } as CancelarConfirmState);
      await send(telefone, `Tem certeza que quer remover o lembrete de ${capitalizeFirst(alvo.titulo)}? (sim/não)`);
      return { success: false, userId: user.id, erro: "cancelar aguardando confirmacao" };
    }
    if (st.acao === "editar")   return await aplicarEditar(user, telefone, alvo, st.patch ?? {});
  }

  await clearContext(user.id);
  return { success: false, userId: user.id, erro: "fluxo desconhecido" };
}

async function iniciarPorIntencao(user: UserRow, telefone: string, intencao: LembreteIntencao): Promise<ProcessResult | null> {
  const acao = intencao.acao;
  if (!acao) return null;

  if (acao === "listar")    return await listarHandler(user, telefone);
  if (acao === "ajuda_lembrete") {
    await send(telefone, "⏰ Lembretes de contas:\n\n• \"lembra de pagar luz dia 10, 180\"\n• \"minhas contas\"\n• \"paguei a luz\"\n• \"cancela a netflix\"");
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "lembrete_ajuda" } };
  }
  if (acao === "pagar")     return await pagarHandler(user, telefone, intencao.dados.titulo);
  if (acao === "cancelar")  return await cancelarHandler(user, telefone, intencao.dados.titulo);
  if (acao === "editar")    return await editarHandler(user, telefone, intencao);

  if (acao === "criar") {
    const state: CriarState = {
      titulo: intencao.dados.titulo,
      valor:  intencao.dados.valor,
      dia:    intencao.dados.dia,
      fixa:   intencao.dados.fixa,
    };
    return await avancarCriar(user, telefone, state);
  }
  return null;
}

// Inicia o fluxo de criação de lembrete com state parcial, pedindo o que falta.
// Usado por detecção automática ("é fixo?" → "sim") pra perguntar o dia de vencimento.
export async function iniciarFluxoCriacaoLembrete(
  user: UserRow,
  telefone: string,
  parcial: { titulo?: string; valor?: number; dia?: number; fixa?: boolean },
): Promise<ProcessResult> {
  log.webhook("lembrete: iniciar criacao via parcial", { userId: user.id, parcial });
  return await avancarCriar(user, telefone, { ...parcial });
}

export async function tryHandleLembretes(user: UserRow, telefone: string, texto: string): Promise<ProcessResult | null> {
  try {
    const ctx = await getContext(user.id);
    if (ctx && ctx.fluxo.startsWith("lembrete_")) {
      log.webhook("lembrete: continua fluxo", { userId: user.id, fluxo: ctx.fluxo });
      return await continuarFluxo(user, telefone, texto, ctx);
    }

    const t = texto.trim().toLowerCase();
    // Gate: só roda NLU se há sinal mínimo de lembrete (evita custo de LLM em toda mensagem).
    // Inclui variações naturais ("ver contas", "lista de contas", "quais contas", "meu lembrete", etc.)
    const sinalLembrete =
      /\b(lembr[ae]|lembrete|me\s+avisa|me\s+lembra|notific|agendar|conta\s+fixa|contas?\s+(?:a|pra|para)\s+pagar|nova\s+conta|anota\s+(?:uma\s+)?conta|anotar?\s+(?:uma\s+)?conta|(?:minhas?|meus?)\s+contas?|(?:minhas?|meus?)\s+lembretes?|quais?\s+(?:as\s+|os\s+|minhas?\s+|meus?\s+)?contas?|(?:ver|listar?|mostrar?|exibir?)\s+(?:as\s+|os\s+|minhas?\s+|meus?\s+|a\s+|o\s+)?(?:contas?|lembretes?)|lista\s+de\s+(?:contas?|lembretes?)|contas?\s+do\s+m[eê]s|o\s+que\s+(?:eu\s+)?(?:tenho|preciso|devo|vou)\s+(?:que\s+|pra\s+|para\s+)?pagar|paguei|quitei|vence|vencimento|cancela(?:r)?\s+(?:a|o|os|as)?\s*(?:luz|netflix|spotify|aluguel|internet|conta|lembrete)|todo\s+dia\s+\d{1,2}|todo\s+m[eê]s)\b/i.test(t);
    if (!sinalLembrete) {
      log.webhook("lembrete: sem sinal — skip", { userId: user.id });
      return null;
    }

    const intencao = await interpretarLembreteComContexto(user.id, texto);
    log.webhook("lembrete: NLU resultado", { userId: user.id, acao: intencao.acao, titulo: intencao.dados.titulo, conf: intencao.dados.confianca, lembreteId: intencao.lembreteId });
    if (intencao.acao === null) return null;

    // Atalho: contexto já achou o lembrete exato → aplica direto
    if (intencao.lembreteId && intencao.acao === "pagar") {
      const alvo = await getLembrete(user.id, intencao.lembreteId);
      if (alvo) return await aplicarPagar(user, telefone, alvo);
    }
    if (intencao.lembreteId && intencao.acao === "cancelar") {
      const alvo = await getLembrete(user.id, intencao.lembreteId);
      if (alvo) {
        await setContext(user.id, FLUXO_CANCELAR, { id: alvo.id, titulo: alvo.titulo } as CancelarConfirmState);
        await send(telefone, `Tem certeza que quer remover o lembrete de ${capitalizeFirst(alvo.titulo)}? (sim/não)`);
        return { success: false, userId: user.id, erro: "cancelar aguardando confirmacao" };
      }
    }

    return await iniciarPorIntencao(user, telefone, intencao);
  } catch (err) {
    log.error("tryHandleLembretes falhou", err, { userId: user.id });
    return null;
  }
}
