import pool from "./db/client";

export async function createTables() {
  try {
    console.log("Tentando conectar no banco...");

    await pool.query(`
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

    await pool.query(`
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

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS senha VARCHAR(255);
    `);

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) NOT NULL DEFAULT 'trial';
    `);

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
    `);

    // Usuários existentes antes da migração: 90 dias de graça a partir do cadastro
    await pool.query(`
      UPDATE users
      SET trial_ends_at = criado_em + INTERVAL '90 days'
      WHERE trial_ends_at IS NULL;
    `);

    await pool.query(`
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id  TEXT        PRIMARY KEY,
        telefone    TEXT        NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
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

    await pool.query(`
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS category_limits (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        categoria    VARCHAR(100) NOT NULL,
        valor_limite NUMERIC(10,2) NOT NULL,
        criado_em    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, categoria)
      );
    `);

    await pool.query(`
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_actions (
        user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        action         VARCHAR(20)  NOT NULL,
        step           VARCHAR(30)  NOT NULL,
        tx_ids         JSONB        NOT NULL DEFAULT '[]',
        selected_tx_id INTEGER,
        expires_at     TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id           SERIAL PRIMARY KEY,
        nome         VARCHAR(50) UNIQUE NOT NULL,
        duration_days INTEGER NOT NULL,
        ativo        BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);

    await pool.query(`
      INSERT INTO plans (nome, duration_days) VALUES
        ('mensal', 30),
        ('anual', 365)
      ON CONFLICT (nome) DO NOTHING;
    `);

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
    `);

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS current_plan VARCHAR(50);
    `);

    console.log("Tabelas criadas/verificadas ✅");
  } catch (error) {
    console.error("ERRO REAL DO BANCO:");
    console.error(error);
  }
}
