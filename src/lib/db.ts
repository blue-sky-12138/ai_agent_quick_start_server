/**
 * MySQL 连接与 llm_logs 表写入（异步、不阻塞接口）
 * 连接配置从环境变量读取，未配置时跳过写入
 */

import mysql from "mysql2/promise";

const TABLE_NAME = "iwala_aiagent_llm_logs";
/** 上传图片表（建议使用库名 szb02：DB_DATABASE=szb02） */
const IMAGE_TABLE_NAME = "iwala_aiagent_uploaded_images";

export type LlmLogType = "question" | "answer";

export interface LlmLogRow {
  agent_instance_id: string;
  agent_user_id: string;
  room_id: string;
  type: LlmLogType;
  content: string;
}

export interface UploadedImageRow {
  id: number;
  agent_instance_id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  image_data: Buffer;
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

const CREATE_IMAGE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${IMAGE_TABLE_NAME} (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  agent_instance_id VARCHAR(255) NOT NULL DEFAULT '',
  file_name VARCHAR(512) NOT NULL DEFAULT '',
  mime_type VARCHAR(128) NOT NULL DEFAULT '',
  file_size INT UNSIGNED NOT NULL DEFAULT 0,
  image_data LONGBLOB NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_agent_instance (agent_instance_id),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`.trim();

let imageTableEnsured = false;

async function ensureImageTable(conn: mysql.PoolConnection): Promise<void> {
  if (imageTableEnsured) return;
  await conn.query(CREATE_IMAGE_TABLE_SQL);
  imageTableEnsured = true;
}

/**
 * 写入一条上传图片记录，返回自增 id；未配置数据库或失败时返回 null
 */
export async function insertUploadedImage(params: {
  agent_instance_id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  image_buffer: Buffer;
}): Promise<number | null> {
  const p = getPool();
  if (!p) return null;
  let conn: mysql.PoolConnection | null = null;
  try {
    conn = await p.getConnection();
    await ensureImageTable(conn);
    const [result] = await conn.query<mysql.ResultSetHeader>(
      `INSERT INTO ${IMAGE_TABLE_NAME} (agent_instance_id, file_name, mime_type, file_size, image_data) VALUES (?, ?, ?, ?, ?)`,
      [
        params.agent_instance_id,
        params.file_name,
        params.mime_type,
        params.file_size,
        params.image_buffer,
      ]
    );
    return result.insertId;
  } catch (err) {
    console.error("[db] insertUploadedImage error:", err);
    return null;
  } finally {
    conn?.release();
  }
}

/**
 * 按主键查询上传图片（用于 GET 接口）
 */
export async function getUploadedImageById(id: number): Promise<UploadedImageRow | null> {
  const p = getPool();
  if (!p) return null;
  let conn: mysql.PoolConnection | null = null;
  try {
    conn = await p.getConnection();
    await ensureImageTable(conn);
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT id, agent_instance_id, file_name, mime_type, file_size, image_data FROM ${IMAGE_TABLE_NAME} WHERE id = ? LIMIT 1`,
      [id]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      agent_instance_id: String(row.agent_instance_id ?? ""),
      file_name: String(row.file_name ?? ""),
      mime_type: String(row.mime_type ?? "application/octet-stream"),
      file_size: Number(row.file_size ?? 0),
      image_data: row.image_data instanceof Buffer ? row.image_data : Buffer.from(row.image_data),
    };
  } catch (err) {
    console.error("[db] getUploadedImageById error:", err);
    return null;
  } finally {
    conn?.release();
  }
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
