/**
 * MySQL 连接与 llm_logs 表写入（异步、不阻塞接口）
 * 连接配置从环境变量读取，未配置时跳过写入
 */

import mysql from "mysql2/promise";

const TABLE_NAME = "iwala_aiagent_llm_logs";

export type LlmLogType = "question" | "answer";

export interface LlmLogRow {
  agent_instance_id: string;
  agent_user_id: string;
  room_id: string;
  type: LlmLogType;
  content: string;
}

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool | null {
  if (pool) return pool;
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_DATABASE ?? process.env.DB_NAME;
  if (!host || !user || !password || !database) {
    return null;
  }
  pool = mysql.createPool({
    host,
    port: Number.isNaN(port) ? 3306 : port,
    user,
    password,
    database,
    charset: "utf8mb4",
    timezone: "Asia/Shanghai",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000,
  });
  return pool;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  agent_instance_id VARCHAR(255) NOT NULL DEFAULT '',
  agent_user_id VARCHAR(255) NOT NULL DEFAULT '',
  room_id VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  type ENUM('question','answer') NOT NULL,
  content TEXT NOT NULL,
  KEY idx_instance_user_room (agent_instance_id, agent_user_id, room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`.trim();

let tableEnsured = false;

async function ensureTable(conn: mysql.PoolConnection): Promise<void> {
  if (tableEnsured) return;
  await conn.query(CREATE_TABLE_SQL);
  tableEnsured = true;
}

/**
 * 异步写入一条 LLM 日志，不抛错、不阻塞调用方
 */
export function insertLlmLog(row: LlmLogRow): void {
  const p = getPool();
  if (!p) return;

  void (async () => {
    let conn: mysql.PoolConnection | null = null;
    try {
      conn = await p.getConnection();
      await ensureTable(conn);
      await conn.query(
        `INSERT INTO ${TABLE_NAME} (agent_instance_id, agent_user_id, room_id, type, content) VALUES (?, ?, ?, ?, ?)`,
        [row.agent_instance_id, row.agent_user_id, row.room_id, row.type, row.content]
      );
    } catch (err) {
      console.error("[db] insertLlmLog error:", err);
    } finally {
      conn?.release();
    }
  })();
}
