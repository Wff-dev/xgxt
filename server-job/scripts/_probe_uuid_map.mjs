/**
 * 一次性探测：日志里那些 UUID 到底属于哪张表
 *
 * 背景：`t_perm_log.target_obj` 里有 29 条形如 `班级 #5d06d652-...`，
 * 想把这些历史记录还原成可读名称，就得先知道 UUID 落在哪张表、哪一列。
 * 这里把候选业务库里所有 ≥32 位的字符列都查一遍，命中即打印。
 *
 * 用法：npx tsx 不需要，直接 node scripts/_probe_uuid_map.mjs
 */
import mysql from 'mysql2/promise';

const IDS = [
  '369f22ed-4e20-4543-85d0-801e8cef480a',
  'd4d84781-857c-43b4-999e-a57667a59cb9',
  'e250c334-c646-4b8c-8d75-61151133e25b',
  '5d06d652-b7df-45a9-9b2d-a9a61679eb66',
  'c5e89e3f-a5d4-48ed-a1e1-9289fd11fba0',
  '72a1cfc4-9a59-43c1-ab20-f84e561f4809',
  '9b36533f-1da8-47c1-890e-dbb6b902cbed',
  '8514cf8d-9b30-4cb4-a307-07076327b700',
  '95dd3f02-448d-4b9b-a407-d3441012d1d8',
];

const DB = process.env.DB_NAME || 'sms_perm';
const HOST = process.env.DB_HOST || '127.0.0.1';
const PORT = Number(process.env.DB_PORT || 3306);
const USER = process.env.DB_USER || 'root';
const PASSWORD = process.env.DB_PASSWORD || 'xueguan123';

const dbs = ['sms_common', 'sms_class', 'sms_job', 'sms_class_jh', 'sms_consult', 'sms_finance'];

const c = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD });
void DB;

for (const db of dbs) {
  const [cols] = await c.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=? AND DATA_TYPE IN ('char','varchar') AND CHARACTER_MAXIMUM_LENGTH>=32`,
    [db],
  );
  const byTable = new Map();
  for (const col of cols) {
    if (!byTable.has(col.TABLE_NAME)) byTable.set(col.TABLE_NAME, []);
    byTable.get(col.TABLE_NAME).push(col.COLUMN_NAME);
  }
  for (const [table, columnNames] of byTable) {
    for (const col of columnNames) {
      const marks = IDS.map(() => '?').join(',');
      let rows;
      try {
        [rows] = await c.query(
          `SELECT ${col} AS hit FROM \`${db}\`.\`${table}\` WHERE ${col} IN (${marks}) LIMIT 3`,
          IDS,
        );
      } catch {
        continue;
      }
      if (rows.length) {
        console.log(`${db}.${table}.${col}  <=  ${rows.map((r) => r.hit).join(', ')}`);
      }
    }
  }
}
await c.end();
