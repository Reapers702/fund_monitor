// 数据库 DDL（与计划书 §6 一致）。全部幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。
// 启动时由 storage/db.ts ensureSchema() 在单事务内执行。
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS fund_basic (
      fund_code   VARCHAR(8)  PRIMARY KEY,
      fund_name   TEXT        NOT NULL,
      fund_full_name TEXT,
      manager     TEXT,
      keeper      TEXT,
      found_date  DATE,
      is_active   INT         NOT NULL DEFAULT 1,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS fund_nav_daily (
      id          BIGSERIAL PRIMARY KEY,
      fund_code   VARCHAR(8)  NOT NULL,
      trade_date  DATE        NOT NULL,
      dwjz        NUMERIC(10,4),
      ljjz        NUMERIC(10,4),
      jzzzl       NUMERIC(8,4),
      sgzt        VARCHAR(16),
      shzt        VARCHAR(16),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT uq_nav UNIQUE (fund_code, trade_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nav ON fund_nav_daily (fund_code, trade_date DESC)`,

  `CREATE TABLE IF NOT EXISTS fund_estimate (
      id         BIGSERIAL PRIMARY KEY,
      fund_code  VARCHAR(8)  NOT NULL,
      est_time   TIMESTAMPTZ NOT NULL,
      est_nav    NUMERIC(10,4),
      est_pct    NUMERIC(8,4),
      source     VARCHAR(16),
      CONSTRAINT uq_est UNIQUE (fund_code, est_time)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_est ON fund_estimate (fund_code, est_time DESC)`,

  `CREATE TABLE IF NOT EXISTS fund_holdings (
      id           BIGSERIAL PRIMARY KEY,
      fund_code    VARCHAR(8) NOT NULL,
      report_date  DATE       NOT NULL,
      rank         INT        NOT NULL,
      stock_code   VARCHAR(16),
      stock_name   TEXT,
      weight       NUMERIC(8,4),
      CONSTRAINT uq_hold UNIQUE (fund_code, report_date, rank)
  )`,

  `CREATE TABLE IF NOT EXISTS stock_daily (
      id          BIGSERIAL PRIMARY KEY,
      stock_code  VARCHAR(16) NOT NULL,
      trade_date  DATE        NOT NULL,
      close       NUMERIC(10,2),
      open        NUMERIC(10,2),
      high        NUMERIC(10,2),
      low         NUMERIC(10,2),
      pct         NUMERIC(8,4),
      volume      NUMERIC(20,0),
      amount      NUMERIC(24,2),
      CONSTRAINT uq_stock UNIQUE (stock_code, trade_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stock ON stock_daily (stock_code, trade_date DESC)`,

  // 说明：新闻表不在本库——raw_news 由另一个 24h 程序维护于 ai_fund 库，本应用只读（见 news/reader.ts）。
  // 历史遗留表 raw_news 若存在可安全 DROP，由 storage/cleanup.ts 或手动清理。

  `CREATE TABLE IF NOT EXISTS ds_advice (
      id            BIGSERIAL PRIMARY KEY,
      fund_code     VARCHAR(8) NOT NULL,
      trade_date    DATE       NOT NULL,
      action        VARCHAR(8) NOT NULL,
      reason        TEXT,
      confidence    NUMERIC(4,2),
      response_raw  JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_advice ON ds_advice (fund_code, trade_date DESC)`,

  `CREATE TABLE IF NOT EXISTS fund_trade (
      id         BIGSERIAL PRIMARY KEY,
      fund_code  VARCHAR(8)  NOT NULL,
      trade_type VARCHAR(4)  NOT NULL,
      shares     NUMERIC(14,2) NOT NULL,
      price      NUMERIC(10,4) NOT NULL,
      fee        NUMERIC(10,4) NOT NULL DEFAULT 0,
      trade_date TIMESTAMPTZ NOT NULL,
      note       TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ftrade ON fund_trade (fund_code, trade_date)`,

  `CREATE TABLE IF NOT EXISTS fund_profile (
      id        INT PRIMARY KEY DEFAULT 1,
      buy_fee_pct  NUMERIC(6,4) NOT NULL DEFAULT 0,
      sell_fee_pct NUMERIC(6,4) NOT NULL DEFAULT 0
  )`
]
