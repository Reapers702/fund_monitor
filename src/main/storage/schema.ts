// 数据库 DDL（与计划书 §6 一致）。全部幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。
// 启动时由 storage/db.ts ensureSchema() 在单事务内执行。
// 多用户（M9）：app_user / user_fund 用户与自选；fund_trade / ds_advice / fund_profile 带 user_id；
// 基金数据（fund_basic 基本信息、净值/估值/重仓股/行情）全局共享，多用户收藏同一基金不重复抓取。
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
      source     VARCHAR(24),
      CONSTRAINT uq_est UNIQUE (fund_code, est_time)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_est ON fund_estimate (fund_code, est_time DESC)`,

  `CREATE TABLE IF NOT EXISTS fund_estimate_diff (
      fund_code   VARCHAR(8)  NOT NULL,
      trade_date  DATE        NOT NULL,
      source      VARCHAR(24),
      est_pct     NUMERIC(8,4),
      nav_pct     NUMERIC(8,4),
      diff_pct    NUMERIC(8,4),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_est_diff PRIMARY KEY (fund_code, trade_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_est_diff ON fund_estimate_diff (fund_code, trade_date DESC)`,

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

  // ---------- 多用户（M9） ----------

  `CREATE TABLE IF NOT EXISTS app_user (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  // 用户自选基金（is_active 1=启用/0=停用）；fund_basic.is_active 弃用，查询全部走本表
  `CREATE TABLE IF NOT EXISTS user_fund (
      user_id    INT NOT NULL REFERENCES app_user(id),
      fund_code  VARCHAR(8) NOT NULL,
      is_active  INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, fund_code)
  )`,

  `CREATE TABLE IF NOT EXISTS fund_profile (
      user_id      INT PRIMARY KEY,
      buy_fee_pct  NUMERIC(6,4) NOT NULL DEFAULT 0,
      sell_fee_pct NUMERIC(6,4) NOT NULL DEFAULT 0
  )`
]

// 单用户 → 多用户迁移（幂等，仅对已有旧库生效；新库直接走 SCHEMA_STATEMENTS 新结构）：
// 历史数据统一归默认用户 "guanxin"（id=1）。
export const MIGRATION_STATEMENTS: string[] = [
  // 用户表：确保 guanxin 存在（新库由 ensureDefaultUser 兜底，此处幂等插入 id=1）
  `INSERT INTO app_user (id, name) VALUES (1, 'guanxin') ON CONFLICT (id) DO NOTHING`,
  // 显式 id 插入不推进 SERIAL 序列，同步 nextval 防止后续新建用户撞主键
  `SELECT setval('app_user_id_seq', (SELECT max(id) FROM app_user))`,

  // 用户自选：把旧 fund_basic.is_active=1 的自选灌入 guanxin
  `INSERT INTO user_fund (user_id, fund_code, is_active)
   SELECT 1, fund_code, is_active FROM fund_basic WHERE is_active = 1
   ON CONFLICT (user_id, fund_code) DO NOTHING`,

  // 持仓 / AI 建议加用户维度，存量归 guanxin
  `ALTER TABLE fund_trade ADD COLUMN IF NOT EXISTS user_id INT`,
  `UPDATE fund_trade SET user_id = 1 WHERE user_id IS NULL`,
  `ALTER TABLE ds_advice ADD COLUMN IF NOT EXISTS user_id INT`,
  `UPDATE ds_advice SET user_id = 1 WHERE user_id IS NULL`,

  // 费率表重建为按用户（旧结构 id=1 单行 → 新结构 user_id 主键），存量归 guanxin
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'fund_profile' AND column_name = 'id')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'fund_profile' AND column_name = 'user_id') THEN
       CREATE TABLE fund_profile_v2 (
         user_id      INT PRIMARY KEY,
         buy_fee_pct  NUMERIC(6,4) NOT NULL DEFAULT 0,
         sell_fee_pct NUMERIC(6,4) NOT NULL DEFAULT 0
       );
       INSERT INTO fund_profile_v2 (user_id, buy_fee_pct, sell_fee_pct)
         SELECT 1, buy_fee_pct, sell_fee_pct FROM fund_profile;
       DROP TABLE fund_profile;
       ALTER TABLE fund_profile_v2 RENAME TO fund_profile;
     END IF;
   END $$`
]
