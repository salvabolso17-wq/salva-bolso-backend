import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { capitalizeFirst, fmtValor } from "../../utils/formatting";
import { fetchPeriodMetrics } from "../reportService";

const ONBOARDING_TIPS: Record<number, string> = {
  10: `Para guardar na meta: guardar 200 viagem 🎯`,
  11: `A previsão mostra como o mês vai fechar.`,
  12: `As próximas listam tudo que vence em breve.`,
};

export async function checkAndSendOnboardingTip(userId: number, telefone: string, evento: string): Promise<boolean> {
  // mes_referencia fixo como sentinel de lifetime (não se repete mensalmente)
  const LIFETIME = new Date("2000-01-01");

  let tipId: number | null = null;

  if (evento === "saida") {
    const countRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
      [userId]
    );
    const n = Number(countRow.rows[0].count);
    if (n === 1) {
      tipId = 1;
    } else if (n >= 7) {
      // Aha moment: só dispara com contexto real (3+ categorias distintas)
      const catRow = await pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT categoria) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
        [userId]
      );
      if (Number(catRow.rows[0].count) < 3) return false; // contexto fraco → silêncio

      const now       = new Date();
      const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const metrics   = await fetchPeriodMetrics(userId, inicioMes, fimMes);

      if (!metrics.total_saidas || !metrics.gastos_por_categoria[0]) return false;

      const inserted = await pool.query(
        `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
         VALUES ($1, 'aha_moment', 4, $2)
         ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
        [userId, LIFETIME]
      );
      if ((inserted.rowCount ?? 0) === 0) return false;

      const top   = metrics.gastos_por_categoria[0];
      const texto = `${capitalizeFirst(top.categoria)} liderou o mês até agora 🙂`;
      await whatsapp.sendText({ to: telefone, text: texto });
      log.whatsapp("aha moment enviado", { to: telefone, userId, totalSaidas: metrics.total_saidas });
      return true;
    }
  } else if (evento === "recorrente_criado") {
    tipId = 12;                    // criou recorrente → próximas
  } else if (evento === "meta_criada") {
    tipId = 10;
  } else if (evento === "limite_criado") {
    tipId = 11;
  }

  if (tipId === null) return false;

  const tipText = ONBOARDING_TIPS[tipId];
  if (!tipText) return false;

  const inserted = await pool.query(
    `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
     VALUES ($1, 'onboarding', $2, $3)
     ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
    [userId, tipId, LIFETIME]
  );

  if ((inserted.rowCount ?? 0) === 0) return false;

  await whatsapp.sendText({ to: telefone, text: tipText });
  log.whatsapp("onboarding tip enviado", { to: telefone, tipId });
  return true;
}

export async function checkAndSendInsights(userId: number, telefone: string, categoria: string): Promise<boolean> {
  const countRow = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
    [userId]
  );
  const insightThreshold = 10;
  if (Number(countRow.rows[0].count) < insightThreshold) return false;

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const metrics = await fetchPeriodMetrics(userId, inicioMes, fimMes);
  if (metrics.total_saidas === 0) return false;

  const catRow = metrics.gastos_por_categoria.find(
    c => c.categoria.toLowerCase() === categoria.toLowerCase()
  );
  if (!catRow) return false;

  const percentual = Math.round((catRow.total / metrics.total_saidas) * 100);
  if (percentual < 50) return false;

  const marco  = 50;
  const mesRef = inicioMes;

  const inserted = await pool.query(
    `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
    [userId, categoria, marco, mesRef]
  );

  if ((inserted.rowCount ?? 0) === 0) return false;

  const insightTexto = percentual >= 65
    ? `${categoria} tá puxando bastante esse mês 👀`
    : `${categoria} tá acima da metade dos gastos este mês.`;

  await whatsapp.sendText({ to: telefone, text: insightTexto });
  log.whatsapp("insight enviado", { to: telefone, categoria, percentual, marco });
  return true;
}

// Insights inteligentes baseados em comparação de períodos e padrões de frequência
export async function checkAndSendSmartInsights(
  userId: number,
  telefone: string,
  descricao: string,
  categoria: string,
): Promise<boolean> {
  try {
    const now     = new Date();
    const ano     = now.getUTCFullYear();
    const mes     = now.getUTCMonth();
    const dia     = now.getUTCDate();
    const LIFETIME = new Date("2000-01-01");

    const inicioMesAtual       = new Date(Date.UTC(ano, mes, 1));
    const inicioMesAnterior    = new Date(Date.UTC(ano, mes - 1, 1));
    const mesmoPeriodoAnterior = new Date(Date.UTC(ano, mes - 1, dia));

    // Precisa de ao menos 5 saídas para comparações fazerem sentido
    const totalRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
      [userId]
    );
    if (Number(totalRow.rows[0].count) < 5) return false;

    function pick(arr: string[]): string { return arr[Math.floor(Math.random() * arr.length)]; }

    async function tryInsight(sentinel: string, mesRef: Date, texto: string): Promise<boolean> {
      const ins = await pool.query(
        `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
        [userId, sentinel, mesRef]
      );
      if ((ins.rowCount ?? 0) === 0) return false;
      await whatsapp.sendText({ to: telefone, text: texto });
      log.whatsapp("smart insight enviado", { to: telefone, userId, sentinel });
      return true;
    }

    // ── 1. Frequência: mesma descrição 3+ vezes nos últimos 30 dias ──────────
    const descNorm = descricao.toLowerCase().trim();
    const freqRow  = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions
       WHERE user_id = $1 AND tipo = 'saida' AND LOWER(descricao) = $2
         AND criado_em >= NOW() - INTERVAL '30 days'`,
      [userId, descNorm]
    );
    if (Number(freqRow.rows[0].count) >= 3) {
      const jaRec = await pool.query(
        `SELECT 1 FROM lembretes WHERE user_id = $1 AND LOWER(titulo) = $2 AND fixa = TRUE AND status IN ('pendente','pago') LIMIT 1`,
        [userId, descNorm]
      );
      if (jaRec.rows.length === 0) {
        const sentinel = `smart_freq_${descNorm.replace(/\W+/g, "_").slice(0, 40)}`;
        const texto = `${capitalizeFirst(descricao)} aparece bastante nos seus gastos recentes.`;
        if (await tryInsight(sentinel, inicioMesAtual, texto)) return true;
      }
    }

    // ── 2–5. Comparação de períodos — só a partir do dia 5 do mês ────────────
    if (dia < 5) return false;

    const [curRow, prevRow, catCurRow, catPrevRow] = await Promise.all([
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2`,
        [userId, inicioMesAtual]
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2 AND criado_em < $3`,
        [userId, inicioMesAnterior, mesmoPeriodoAnterior]
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND LOWER(categoria) = LOWER($2) AND criado_em >= $3`,
        [userId, categoria, inicioMesAtual]
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND LOWER(categoria) = LOWER($2)
           AND criado_em >= $3 AND criado_em < $4`,
        [userId, categoria, inicioMesAnterior, mesmoPeriodoAnterior]
      ),
    ]);

    const spendAtual    = Number(curRow.rows[0].total);
    const spendAnterior = Number(prevRow.rows[0].total);
    const catAtual      = Number(catCurRow.rows[0].total);
    const catAnterior   = Number(catPrevRow.rows[0].total);

    // ── 2. Mês mais pesado ────────────────────────────────────────────────────
    if (spendAnterior > 80 && spendAtual > spendAnterior * 1.25) {
      const sentinel = `smart_mes_alto_${mes}_${ano}`;
      const texto = pick([
        "Esse mês está mais pesado que o anterior até aqui.",
        "Esse mês está mais apertado que o anterior.",
      ]);
      if (await tryInsight(sentinel, inicioMesAtual, texto)) return true;
    }

    // ── 3. Mês mais leve ──────────────────────────────────────────────────────
    if (spendAnterior > 80 && spendAtual > 20 && spendAtual < spendAnterior * 0.75) {
      const sentinel = `smart_mes_baixo_${mes}_${ano}`;
      const texto = "Esse mês você está gastando menos que no anterior 🙂";
      if (await tryInsight(sentinel, inicioMesAtual, texto)) return true;
    }

    // ── 4. Categoria subindo ──────────────────────────────────────────────────
    if (catAnterior > 40 && catAtual > catAnterior * 1.35) {
      const catKey   = categoria.replace(/\s+/g, "_").toLowerCase().slice(0, 30);
      const sentinel = `smart_cat_alta_${catKey}_${mes}_${ano}`;
      const texto    = `${categoria} está mais alto esse mês em comparação ao anterior.`;
      if (await tryInsight(sentinel, inicioMesAtual, texto)) return true;
    }

    // ── 5. Categoria melhorando ───────────────────────────────────────────────
    if (catAnterior > 40 && catAtual > 0 && catAtual < catAnterior * 0.65) {
      const catKey   = categoria.replace(/\s+/g, "_").toLowerCase().slice(0, 30);
      const sentinel = `smart_cat_baixa_${catKey}_${mes}_${ano}`;
      const texto    = pick([
        `Esse mês você gastou menos com ${categoria.toLowerCase()} 🙂`,
        `${categoria} mais controlado esse mês 🙂`,
      ]);
      if (await tryInsight(sentinel, inicioMesAtual, texto)) return true;
    }

    return false;
  } catch (err) {
    log.error("falha smart insights", err, { userId });
    return false;
  }
}

// Micro insight contextual — raro, leve, observações de hoje apenas
export async function sendContextualMicroInsight(userId: number, telefone: string, categoria: string): Promise<boolean> {
  try {
    const now         = new Date();
    const todayUTC    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const tomorrowUTC = new Date(todayUTC.getTime() + 86400000);
    const twoMinsAgo  = new Date(now.getTime() - 120000);
    const twoHoursAgo = new Date(now.getTime() - 7200000);

    // Rapid-fire: 2+ tx nos últimos 2 min → silêncio total
    const rapidRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2`,
      [userId, twoMinsAgo]
    );
    if (Number(rapidRow.rows[0].count) > 1) return false;

    // Máx 1 micro insight por dia por usuário
    const alreadySent = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sent_insights WHERE user_id = $1 AND categoria = 'micro_dia' AND mes_referencia = $2`,
      [userId, todayUTC]
    );
    if (Number(alreadySent.rows[0].count) > 0) return false;

    function pick(opts: string[]): string { return opts[Math.floor(Math.random() * opts.length)]; }

    let insight: string | null = null;

    // Condição 1: 3+ gastos na mesma categoria hoje
    const catRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions
       WHERE user_id = $1 AND LOWER(categoria) = LOWER($2) AND tipo = 'saida'
         AND criado_em >= $3 AND criado_em < $4`,
      [userId, categoria, todayUTC, tomorrowUTC]
    );
    if (Number(catRow.rows[0].count) >= 4) {
      insight = pick([
        `${categoria} apareceu bastante hoje.`,
        `Bastante ${categoria.toLowerCase()} hoje.`,
      ]);
    }

    // Condição 2: 5+ gastos nas últimas 2h (ritmo acelerado)
    if (!insight) {
      const paceRow = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2`,
        [userId, twoHoursAgo]
      );
      if (Number(paceRow.rows[0].count) >= 5) {
        insight = pick([
          "Bastante saída concentrada hoje 👀",
          "Hoje teve bastante movimento.",
        ]);
      }
    }

    if (!insight) return false;

    // Registra dedup — só envia se foi o primeiro a inserir
    const ins = await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, 'micro_dia', 1, $2)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, todayUTC]
    );
    if ((ins.rowCount ?? 0) === 0) return false;

    await whatsapp.sendText({ to: telefone, text: insight });
    log.whatsapp("micro insight enviado", { to: telefone, userId, insight });
    return true;
  } catch (err) {
    log.error("falha micro insight", err, { userId });
    return false;
  }
}

// ── Alerta proativo de limite (80% / 100%) ───────────────────────────────────
export async function checkAndAlertLimite(userId: number, telefone: string, categoria: string): Promise<boolean> {
  try {
    const hoje      = new Date();
    const mesRefDt  = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1));
    const mesAtual  = hoje.toISOString().slice(0, 7);

    const limiteR = await pool.query<{ valor_limite: string }>(
      `SELECT valor_limite FROM category_limits WHERE user_id = $1 AND categoria = $2`,
      [userId, categoria]
    );
    if (limiteR.rows.length === 0) return false;
    const limite = Number(limiteR.rows[0].valor_limite);
    if (!(limite > 0)) return false;

    const gastoR = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(valor),0) AS total FROM transactions
       WHERE user_id = $1 AND tipo = 'saida' AND categoria = $2
         AND to_char(criado_em,'YYYY-MM') = $3`,
      [userId, categoria, mesAtual]
    );
    const gasto = Number(gastoR.rows[0].total);
    const pct   = gasto / limite;
    if (pct < 0.8) return false;

    const marco = pct >= 1 ? 100 : 80;
    const ins = await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, 'alerta_limite', $2, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, marco, mesRefDt]
    );
    if ((ins.rowCount ?? 0) === 0) return false;

    const restante = limite - gasto;
    const msg = pct >= 1
      ? `🚨 Você estourou o limite de ${capitalizeFirst(categoria)}!\n\nLimite: ${fmtValor(limite)}\nGasto: ${fmtValor(gasto)}`
      : `⚠️ Você já usou 80% do limite de ${capitalizeFirst(categoria)}.\n\nLimite: ${fmtValor(limite)}\nGasto: ${fmtValor(gasto)}\nAinda restam: ${fmtValor(restante)}`;

    await whatsapp.sendText({ to: telefone, text: msg });
    log.whatsapp("alerta limite enviado", { to: telefone, userId, categoria, marco, pct });
    return true;
  } catch (err) {
    log.error("falha alerta limite", err, { userId, categoria });
    return false;
  }
}

// ── Mensagem de descoberta de features após 15 gastos ────────────────────────
export async function checkAndSendDiscoveryMessage(userId: number, telefone: string): Promise<boolean> {
  try {
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`,
      [userId]
    );
    if (Number(r.rows[0].count) !== 15) return false;

    const LIFETIME = new Date("2000-01-01");
    const ins = await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, 'discovery_15', 1, $2)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, LIFETIME]
    );
    if ((ins.rowCount ?? 0) === 0) return false;

    await whatsapp.sendText({
      to:   telefone,
      text: `🎉 Você já registrou 15 gastos!\n\nAproveite tudo que tenho pra oferecer:\n\n📊 *resumo* — seus gastos por categoria\n💰 *saldo* — quanto ainda sobra no mês\n🏠 *contas fixas* — suas despesas mensais\n🎯 *metas* — guardar pra um objetivo\n\nÉ só mandar o comando 😊`,
    });
    log.whatsapp("discovery 15 gastos enviado", { to: telefone, userId });
    return true;
  } catch (err) {
    log.error("falha discovery message", err, { userId });
    return false;
  }
}
