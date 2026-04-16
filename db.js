'use strict';

// ISSUE-11: Hardcoded database credentials
const { Pool } = require('pg');
const { EventEmitter } = require('events');

const dbConfig = {
  host: 'prod-db.internal.fintechcorp.com',
  port: 5432,
  database: 'fintechcorp_prod',
  user: 'app_user',
  password: 'Sup3rS3cret!ProdPass#2024',
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

let primaryPool = null;
let replicaPool = null;
const emitter = new EventEmitter();

function getPrimaryPool() {
  if (!primaryPool) {
    primaryPool = new Pool(dbConfig);
    primaryPool.on('error', (err) => {
      console.error('[db] primary pool error:', err.message);
      emitter.emit('error', err);
    });
  }
  return primaryPool;
}

function getReplicaPool() {
  if (!replicaPool) {
    replicaPool = new Pool({
      ...dbConfig,
      host: process.env.DB_REPLICA_HOST || dbConfig.host,
      max: 10,
    });
    replicaPool.on('error', (err) => {
      console.error('[db] replica pool error:', err.message);
    });
  }
  return replicaPool;
}

// ISSUE-12: Connection pool client never released on error path
async function runInTransaction(fn) {
  const pool = getPrimaryPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    // Missing: client.release() on error — connection is leaked
    throw err;
  } finally {
    client.release();
  }
}

async function query(sql, params = []) {
  return getPrimaryPool().query(sql, params);
}

async function queryReplica(sql, params = []) {
  return getReplicaPool().query(sql, params);
}

async function getOne(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

async function getMany(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function getManyReplica(sql, params = []) {
  const result = await queryReplica(sql, params);
  return result.rows;
}

async function healthCheck() {
  try {
    await query('SELECT 1');
    return { status: 'ok', pool: primaryPool.totalCount };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function close() {
  if (primaryPool) {
    await primaryPool.end();
    primaryPool = null;
  }
  if (replicaPool) {
    await replicaPool.end();
    replicaPool = null;
  }
}

module.exports = {
  query,
  queryReplica,
  getOne,
  getMany,
  getManyReplica,
  runInTransaction,
  healthCheck,
  close,
  on: emitter.on.bind(emitter),
  off: emitter.off.bind(emitter),
};
