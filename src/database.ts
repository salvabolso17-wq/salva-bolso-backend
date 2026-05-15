import pool from "./db/client";

async function step(nome: string, sql: string): Promise<void> {
  try {
    await pool.query(sql);
    console.log(`[SCHEMA] ok: ${nome}`);
  } catch (err) {
    console.error(`[SCHEMA] FALHOU: ${nome}`);
    throw err;
  }
}

export async function createTables() {
  try {
    console.log("[SCHEMA] iniciando createTables...");

    await step("CREATE users", `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telefone VARCHAR(20) UNIQUE NOT NULL,
        nome VARCHAR(100),
        renda NUMERIC(10,2) DEFAULT 0,
        renda_extra NUMERIC(10,2) DEFAULT 0,
        subscription_status VARCHAR(20) NOT NULL DEFAULT 'trial',
        trial_ends_at TIMESTAMPTZ,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await step("CREATE transactions", `
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        tipo VARCHAR(20) NOT NULL,
        valor NUMERIC(10,2) NOT NULL,
        categoria VARCHAR(100),
        descricao TEXT,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await step("ALTER users.senha", `ALTER TABLE users ADD COLUMN IF NOT EXISTS senha VARCHAR(255);`);
    await step("ALTER users.subscription_status", `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) NOT NULL DEFAULT 'trial';`);
    await step("ALTER users.trial_ends_at", `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;`);

    // Usuários existentes antes da migração: 90 dias de graça a partir do cadastro
    await step("BACKFILL users.trial_ends_at", `
      UPDATE users
      SET trial_ends_at = criado_em + INTERVAL '90 days'
      WHERE trial_ends_at IS NULL;
    `);

    await step("CREATE financial_goals", `
      CREATE TABLE IF NOT EXISTS financial_goals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        categoria VARCHAR(100) NOT NULL,
        valor_meta NUMERIC(10,2) NOT NULL,
        mes_referencia DATE NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, categoria, mes_referencia)
      );
    `);

    await step("CREATE processed_messages", `
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id  TEXT        PRIMARY KEY,
        telefone    TEXT        NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await step("CREATE sent_insights", `
      CREATE TABLE IF NOT EXISTS sent_insights (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        categoria     VARCHAR(100) NOT NULL,
        marco         INTEGER NOT NULL,
        mes_referencia DATE NOT NULL,
        criado_em     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, categoria, marco, mes_referencia)
      );
    `);

    await step("CREATE user_goals", `
      CREATE TABLE IF NOT EXISTS user_goals (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        nome         VARCHAR(100) NOT NULL,
        valor_meta   NUMERIC(10,2) NOT NULL,
        valor_atual  NUMERIC(10,2) NOT NULL DEFAULT 0,
        criado_em    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, nome)
      );
    `);

    await step("CREATE category_limits", `
      CREATE TABLE IF NOT EXISTS category_limits (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        categoria    VARCHAR(100) NOT NULL,
        valor_limite NUMERIC(10,2) NOT NULL,
        criado_em    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, categoria)
      );
    `);

    await step("CREATE recurring_expenses", `
      CREATE TABLE IF NOT EXISTS recurring_expenses (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        nome        VARCHAR(100) NOT NULL,
        valor       NUMERIC(10,2) NOT NULL,
        frequencia  VARCHAR(20) NOT NULL DEFAULT 'mensal',
        ativo       BOOLEAN NOT NULL DEFAULT TRUE,
        criado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, nome)
      );
    `);

    await step("CREATE pending_actions", `
      CREATE TABLE IF NOT EXISTS pending_actions (
        user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        action         VARCHAR(100) NOT NULL,
        step           VARCHAR(100) NOT NULL,
        tx_ids         JSONB        NOT NULL DEFAULT '[]',
        selected_tx_id INTEGER,
        expires_at     TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
      );
    `);

    // Migração: garante a expansão de colunas antigas (caso a tabela tenha sido criada com tamanho menor)
    await step("ALTER pending_actions widen cols", `
      ALTER TABLE pending_actions
        ALTER COLUMN action TYPE VARCHAR(100),
        ALTER COLUMN step TYPE VARCHAR(100);
    `);

    await step("CREATE installments", `
      CREATE TABLE IF NOT EXISTS installments (
        id             SERIAL PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        nome           TEXT NOT NULL,
        valor_total    NUMERIC(10,2) NOT NULL DEFAULT 0,
        valor_parcela  NUMERIC(10,2) NOT NULL,
        total_parcelas INTEGER NOT NULL,
        parcelas_pagas INTEGER NOT NULL DEFAULT 0,
        categoria      TEXT NOT NULL DEFAULT 'Outros',
        criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ativo          BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);

    await step("INDEX installments_user_id_idx", `
      CREATE INDEX IF NOT EXISTS installments_user_id_idx ON installments(user_id);
    `);

    await step("CREATE plans", `
      CREATE TABLE IF NOT EXISTS plans (
        id           SERIAL PRIMARY KEY,
        nome         VARCHAR(50) UNIQUE NOT NULL,
        duration_days INTEGER NOT NULL,
        ativo        BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);

    await step("SEED plans", `
      INSERT INTO plans (nome, duration_days) VALUES
        ('mensal', 30),
        ('anual', 365)
      ON CONFLICT (nome) DO NOTHING;
    `);

    await step("ALTER users.subscription_expires_at", `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;`);
    await step("ALTER users.current_plan", `ALTER TABLE users ADD COLUMN IF NOT EXISTS current_plan VARCHAR(50);`);
    await step("ALTER users.ultimo_nudge_em", `ALTER TABLE users ADD COLUMN IF NOT EXISTS ultimo_nudge_em DATE;`);
    await step("ALTER users.ultimo_nudge_dias", `ALTER TABLE users ADD COLUMN IF NOT EXISTS ultimo_nudge_dias INT;`);

    // Lembretes de contas (feature conversacional)
    await step("CREATE lembretes", `
      CREATE TABLE IF NOT EXISTS lembretes (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        titulo          VARCHAR(120) NOT NULL,
        valor           NUMERIC(12,2) NOT NULL,
        dia_vencimento  INT NOT NULL CHECK (dia_vencimento BETWEEN 1 AND 31),
        fixa            BOOLEAN NOT NULL DEFAULT TRUE,
        proxima_data    DATE NOT NULL,
        status          VARCHAR(20) NOT NULL DEFAULT 'pendente',
        ultimo_aviso_em DATE,
        criado_em       TIMESTAMP DEFAULT NOW(),
        atualizado_em   TIMESTAMP DEFAULT NOW()
      );
    `);
    await step("INDEX idx_lembretes_proxima_data", `
      CREATE INDEX IF NOT EXISTS idx_lembretes_proxima_data ON lembretes(proxima_data, status);
    `);
    await step("INDEX idx_lembretes_user", `
      CREATE INDEX IF NOT EXISTS idx_lembretes_user ON lembretes(user_id, status);
    `);

    // Contexto conversacional persistente (substitui state in-memory para fluxos multi-step)
    await step("CREATE conversation_context", `
      CREATE TABLE IF NOT EXISTS conversation_context (
        user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        fluxo         VARCHAR(40) NOT NULL,
        dados         JSONB NOT NULL DEFAULT '{}',
        expira_em     TIMESTAMP NOT NULL,
        atualizado_em TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("[SCHEMA] createTables concluído ✅");
  } catch (error) {
    console.error("[SCHEMA] ERRO ao criar/migrar schema — abortando boot:");
    console.error(error);
    throw error;
  }
}

export async function cleanupConversationContextExpirado(): Promise<number> {
  try {
    const r = await pool.query(`DELETE FROM conversation_context WHERE expira_em < NOW()`);
    const n = r.rowCount ?? 0;
    if (n > 0) console.log(`[CLEANUP] conversation_context: ${n} expirados removidos`);
    return n;
  } catch (err) {
    console.error("[CLEANUP] falha em conversation_context:", err);
    return 0;
  }
}
