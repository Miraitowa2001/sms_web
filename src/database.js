/**
 * 数据库初始化
 * 使用 sql.js (纯JS SQLite实现) 存储设备信息和消息记录
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// 确保数据目录存在
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'lvyou.db');

let db = null;
let SQL = null;

// 初始化数据库
async function initDatabase() {
    SQL = await initSqlJs();
    
    // 尝试加载已存在的数据库
    if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }
    
    // 创建表结构
    db.run(`
        CREATE TABLE IF NOT EXISTS devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dev_id TEXT UNIQUE NOT NULL,
            name TEXT DEFAULT '',
            hw_ver TEXT DEFAULT '',
            last_ip TEXT DEFAULT '',
            last_ssid TEXT DEFAULT '',
            last_dbm INTEGER DEFAULT 0,
            status TEXT DEFAULT 'offline',
            last_seen_at TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS sim_cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dev_id TEXT NOT NULL,
            slot INTEGER NOT NULL,
            iccid TEXT DEFAULT '',
            imsi TEXT DEFAULT '',
            msisdn TEXT DEFAULT '',
            operator TEXT DEFAULT '',
            dbm INTEGER DEFAULT 0,
            status TEXT DEFAULT 'unknown',
            plmn TEXT DEFAULT '',
            updated_at TEXT DEFAULT (datetime('now', 'localtime')),
            UNIQUE(dev_id, slot)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dev_id TEXT NOT NULL,
            type INTEGER NOT NULL,
            type_name TEXT DEFAULT '',
            raw_data TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS sms_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dev_id TEXT NOT NULL,
            slot INTEGER NOT NULL,
            msisdn TEXT DEFAULT '',
            phone_num TEXT NOT NULL,
            content TEXT NOT NULL,
            sms_time TEXT,
            direction TEXT DEFAULT 'in',
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS call_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dev_id TEXT NOT NULL,
            slot INTEGER NOT NULL,
            msisdn TEXT DEFAULT '',
            phone_num TEXT NOT NULL,
            msg_type INTEGER NOT NULL,
            call_type TEXT NOT NULL,
            call_time TEXT,
            duration INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS push_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT UNIQUE NOT NULL,
            enabled INTEGER DEFAULT 0,
            config TEXT DEFAULT '{}',
            events TEXT DEFAULT '[]',
            updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);
    
    // 初始化默认配置
    const channels = ['wecom', 'feishu', 'smtp'];
    for (const channel of channels) {
        try {
            // 检查是否存在配置
            // 注意：sql.js 的 get 需要数组参数
            const stmt = db.prepare('SELECT id FROM push_config WHERE channel = ?');
            const exists = stmt.get([channel]);
            stmt.free(); // 释放语句

            if (!exists) {
                db.run('INSERT INTO push_config (channel, enabled, config, events) VALUES (?, 0, "{}", "[]")', [channel]);
                console.log(`[DB] 初始化推送通道: ${channel}`);
            }
        } catch (e) {
            // 忽略唯一约束错误，可能是并发或重复初始化
            if (!e.message.includes('UNIQUE constraint failed')) {
                console.error(`[DB] 初始化通道 ${channel} 失败:`, e.message);
            }
        }
    }

    console.log('[DB] 数据库初始化完成');
    
    // 保存数据库
    saveDatabase();
    
    return db;
}

// 保存数据库到文件
function saveDatabase() {
    if (db) {
        try {
            const data = db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(dbPath, buffer);
            // console.log('[DB] 数据库已保存'); // 调试用，避免日志过多可注释
        } catch (e) {
            console.error('[DB] 保存数据库失败:', e);
        }
    }
}

// 定期自动保存
setInterval(() => {
    saveDatabase();
}, 30000); // 每30秒保存一次

// 封装的数据库操作方法，兼容之前的API
const dbWrapper = {
    prepare: (sql) => {
        return {
            run: (...params) => {
                try {
                    db.run(sql, params);
                    saveDatabase();
                    return { changes: db.getRowsModified() };
                } catch (e) {
                    console.error('[DB Error]', e.message);
                    return { changes: 0 };
                }
            },
            get: (...params) => {
                try {
                    const stmt = db.prepare(sql);
                    stmt.bind(params);
                    if (stmt.step()) {
                        const columns = stmt.getColumnNames();
                        const values = stmt.get();
                        stmt.free();
                        const result = {};
                        columns.forEach((col, i) => result[col] = values[i]);
                        return result;
                    }
                    stmt.free();
                    return undefined;
                } catch (e) {
                    console.error('[DB Error]', e.message);
                    return undefined;
                }
            },
            all: (...params) => {
                try {
                    const stmt = db.prepare(sql);
                    stmt.bind(params);
                    const results = [];
                    const columns = stmt.getColumnNames();
                    while (stmt.step()) {
                        const values = stmt.get();
                        const row = {};
                        columns.forEach((col, i) => row[col] = values[i]);
                        results.push(row);
                    }
                    stmt.free();
                    return results;
                } catch (e) {
                    console.error('[DB Error]', e.message);
                    return [];
                }
            }
        };
    },
    exec: (sql) => {
        try {
            db.exec(sql);
            saveDatabase();
        } catch (e) {
            console.error('[DB Error]', e.message);
        }
    },
    pragma: () => {} // sql.js 不支持 pragma，忽略
};

module.exports = { initDatabase, dbWrapper, saveDatabase };
