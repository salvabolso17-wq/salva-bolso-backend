import { Router, Request } from "express";
import pool from "../db/client";
import { authMiddleware, AuthRequest } from "../middleware/auth";

const router = Router();

router.use(authMiddleware);

function toFirstOfMonth(mes: string): string | null {
  // Aceita "2026-05" ou "2026-05-01"
  const match = mes.match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-01`;
}

function calcularStatus(percentual: number): "dentro_da_meta" | "alerta" | "excedido" {
  if (percentual >= 100) return "excedido";
  if (percentual >= 80) return "alerta";
  return "dentro_da_meta";
}

// POST /financial-goals
router.post("/", async (req: Request, res) => {
  try {
    const { categoria, valor_meta, mes_referencia } = req.body;
    const userId = (req as AuthRequest).userId;

    if (!categoria || !valor_meta || !mes_referencia) {
      res.status(400).json({ error: "Campos obrigatórios: categoria, valor_meta, mes_referencia" });
      return;
    }

    const mesFormatado = toFirstOfMonth(mes_referencia);
    if (!mesFormatado) {
      res.status(400).json({ error: "mes_referencia deve estar no formato YYYY-MM" });
      return;
    }

    const result = await pool.query(
      `INSERT INTO financial_goals (user_id, categoria, valor_meta, mes_referencia)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, categoria, valor_meta, mesFormatado]
    );

    res.status(201).json({ message: "Meta criada", data: result.rows[0] });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      res.status(400).json({ error: "Já existe uma meta para essa categoria neste mês" });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "Erro ao criar meta" });
  }
});

// GET /financial-goals/:userId
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT * FROM financial_goals
       WHERE user_id = $1
       ORDER BY mes_referencia DESC, categoria`,
      [userId]
    );

    res.json({ message: "Metas encontradas", data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao buscar metas" });
  }
});

// GET /financial-goals/:userId/resumo?mes=2026-05
router.get("/:userId/resumo", async (req, res) => {
  try {
    const { userId } = req.params;
    const mesParam = (req.query.mes as string) ?? new Date().toISOString().slice(0, 7);

    const mesFormatado = toFirstOfMonth(mesParam);
    if (!mesFormatado) {
      res.status(400).json({ error: "Parâmetro mes deve estar no formato YYYY-MM" });
      return;
    }

    const userResult = await pool.query("SELECT id FROM users WHERE id = $1", [userId]);
    if (userResult.rows.length === 0) {
      res.status(404).json({ error: "Usuário não encontrado" });
      return;
    }

    const result = await pool.query(
      `SELECT
         fg.id,
         fg.categoria,
         fg.valor_meta,
         fg.mes_referencia,
         COALESCE(SUM(t.valor), 0) AS valor_gasto
       FROM financial_goals fg
       LEFT JOIN transactions t
         ON t.user_id = fg.user_id
         AND t.categoria = fg.categoria
         AND t.tipo = 'saida'
         AND DATE_TRUNC('month', t.criado_em) = DATE_TRUNC('month', fg.mes_referencia)
       WHERE fg.user_id = $1
         AND fg.mes_referencia = $2
       GROUP BY fg.id, fg.categoria, fg.valor_meta, fg.mes_referencia
       ORDER BY fg.categoria`,
      [userId, mesFormatado]
    );

    const metas = result.rows.map((row) => {
      const valorMeta = Number(row.valor_meta);
      const valorGasto = Number(row.valor_gasto);
      const percentual = valorMeta > 0 ? (valorGasto / valorMeta) * 100 : 0;

      return {
        id: row.id,
        categoria: row.categoria,
        mes_referencia: row.mes_referencia,
        valor_meta: valorMeta,
        valor_gasto: valorGasto,
        valor_disponivel: Math.max(valorMeta - valorGasto, 0),
        percentual_usado: Math.round(percentual * 100) / 100,
        status: calcularStatus(percentual),
      };
    });

    const alertas = metas.filter((m) => m.status !== "dentro_da_meta");

    res.json({
      message: "Resumo de metas",
      data: {
        mes: mesParam,
        metas,
        alertas_count: alertas.length,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao calcular resumo de metas" });
  }
});

// PUT /financial-goals/:id
router.put("/:id", async (req: Request, res) => {
  try {
    const { id } = req.params;
    const { valor_meta, categoria, mes_referencia } = req.body;

    if (!valor_meta && !categoria && !mes_referencia) {
      res.status(400).json({ error: "Informe ao menos um campo para atualizar" });
      return;
    }

    const mesFormatado = mes_referencia ? toFirstOfMonth(mes_referencia) : null;
    if (mes_referencia && !mesFormatado) {
      res.status(400).json({ error: "mes_referencia deve estar no formato YYYY-MM" });
      return;
    }

    const result = await pool.query(
      `UPDATE financial_goals
       SET
         valor_meta      = COALESCE($1, valor_meta),
         categoria       = COALESCE($2, categoria),
         mes_referencia  = COALESCE($3, mes_referencia)
       WHERE id = $4
       RETURNING *`,
      [valor_meta ?? null, categoria ?? null, mesFormatado, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Meta não encontrada" });
      return;
    }

    res.json({ message: "Meta atualizada", data: result.rows[0] });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      res.status(400).json({ error: "Já existe uma meta para essa categoria neste mês" });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "Erro ao atualizar meta" });
  }
});

// DELETE /financial-goals/:id
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "DELETE FROM financial_goals WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Meta não encontrada" });
      return;
    }

    res.json({ message: "Meta removida", data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao remover meta" });
  }
});

export default router;
