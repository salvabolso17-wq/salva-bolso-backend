import { Router, Request } from "express";
import pool from "../db/client";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { parseTransaction } from "../utils/parseTransaction";

const router = Router();

router.use(authMiddleware);

router.post("/", async (req, res) => {
  try {
    const { user_id, tipo, valor, categoria, descricao } = req.body;

    if (!user_id || !tipo || !valor) {
      res.status(400).json({ error: "Campos obrigatórios: user_id, tipo, valor" });
      return;
    }

    if (tipo !== "entrada" && tipo !== "saida") {
      res.status(400).json({ error: "tipo deve ser 'entrada' ou 'saida'" });
      return;
    }

    const result = await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user_id, tipo, valor, categoria ?? null, descricao ?? null]
    );

    res.status(201).json({ message: "Transação criada", data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao criar transação" });
  }
});

router.post("/quick-add", async (req: Request, res) => {
  try {
    const { texto } = req.body;
    const userId = (req as AuthRequest).userId;

    if (!texto || typeof texto !== "string") {
      res.status(400).json({ error: "Campo obrigatório: texto" });
      return;
    }

    const parsed = parseTransaction(texto);

    if (!parsed) {
      res.status(400).json({ error: "Não foi possível interpretar o texto. Tente: '120 mercado'" });
      return;
    }

    const result = await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, parsed.tipo, parsed.valor, parsed.categoria, parsed.descricao]
    );

    res.status(201).json({
      message: "Transação registrada",
      data: {
        transacao: result.rows[0],
        interpretado: parsed,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao registrar transação" });
  }
});

router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id = $1
       ORDER BY criado_em DESC`,
      [userId]
    );

    res.json({ message: "Transações encontradas", data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao buscar transações" });
  }
});

router.get("/:userId/resumo", async (req, res) => {
  try {
    const { userId } = req.params;

    const userResult = await pool.query(
      "SELECT id FROM users WHERE id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: "Usuário não encontrado" });
      return;
    }

    const [totaisResult, ultimasResult] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE 0 END), 0) AS total_entradas,
           COALESCE(SUM(CASE WHEN tipo = 'saida'   THEN valor ELSE 0 END), 0) AS total_saidas,
           COUNT(*) AS quantidade_transacoes
         FROM transactions
         WHERE user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT * FROM transactions
         WHERE user_id = $1
         ORDER BY criado_em DESC
         LIMIT 5`,
        [userId]
      ),
    ]);

    const { total_entradas, total_saidas, quantidade_transacoes } = totaisResult.rows[0];
    const saldo = Number(total_entradas) - Number(total_saidas);

    res.json({
      message: "Resumo financeiro",
      data: {
        total_entradas: Number(total_entradas),
        total_saidas: Number(total_saidas),
        saldo,
        quantidade_transacoes: Number(quantidade_transacoes),
        ultimas_transacoes: ultimasResult.rows,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao calcular resumo" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "DELETE FROM transactions WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Transação não encontrada" });
      return;
    }

    res.json({ message: "Transação removida", data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao remover transação" });
  }
});

export default router;
