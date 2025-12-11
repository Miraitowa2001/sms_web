/**
 * 数据库初始化
 * 使用 sql.js (纯JS SQLite实现) 存储设备信息和消息记录
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');

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
            start_time TEXT,
            duration INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);
    // 检查 call_records 表是否有 duration 字段 (用于旧版数据库升级)
    try {
        db.prepare("SELECT duration FROM call_records LIMIT 1").run();
    } catch (e) {
        console.log('[DB] 添加 duration 字段到 call_records 表');
        db.run("ALTER TABLE call_records ADD COLUMN duration INTEGER DEFAULT 0");
    }
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
    
    // 执行一次清理
    cleanupDatabase();

    // 保存数据库
    saveDatabase();
    
    return db;
}

// 清理旧数据
function cleanupDatabase() {
    if (!db || !config.log || !config.log.retentionDays) return;
    
    const days = config.log.retentionDays;
    if (days <= 0) return;

    try {
        // 计算截止日期 (北京时间)
        const now = new Date();
        const threshold = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        
        // 格式化为 YYYY-MM-DD HH:mm:ss
        const pad = n => n < 10 ? '0' + n : n;
        const utc = threshold.getTime() + (threshold.getTimezoneOffset() * 60000);
        const beijingTime = new Date(utc + (3600000 * 8));
        const timeStr = `${beijingTime.getFullYear()}-${pad(beijingTime.getMonth() + 1)}-${pad(beijingTime.getDate())} ${pad(beijingTime.getHours())}:${pad(beijingTime.getMinutes())}:${pad(beijingTime.getSeconds())}`;

        // 清理 messages 表
        db.run("DELETE FROM messages WHERE created_at < ?", [timeStr]);
        const changes = db.getRowsModified();
        
        if (changes > 0) {
            console.log(`[DB] 自动清理: 删除了 ${changes} 条旧日志 (早于 ${timeStr})`);
        }
    } catch (e) {
        console.error('[DB] 自动清理失败:', e);
    }
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
    cleanupDatabase(); // 保存前清理
    saveDatabase();
}, 30000); // 每30秒保存一次

// 封装的数据库操作方法，兼容之前的API
const dbWrapper = {
    prepare: (sql) => {
        return {
            run: (...params) => {
                try {
                    // 使用 prepare + run 替代直接 db.run，确保参数绑定正确
                    const stmt = db.prepare(sql);
                    stmt.run(params);
                    stmt.free();
                    
                    const changes = db.getRowsModified();
                    // 仅在有变动且不是定时任务时打印日志，或者直接注释掉以减少干扰
                    if (changes > 0 && !sql.includes('last_seen_at <')) {
                        console.log(`[DB] Execute: ${sql.replace(/\s+/g, ' ').trim().substring(0, 50)}... | Changes: ${changes}`);
                    }
                    
                    saveDatabase();
                    return { changes };
                } catch (e) {
                    console.error('[DB Error] Run:', e.message || e, 'SQL:', sql, 'Params:', params);
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
                    console.error('[DB Error] Get:', e.message || e);
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
                    console.error('[DB Error] All:', e.message || e);
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
            console.error('[DB Error] Exec:', e.message || e);
        }
    },
    pragma: () => {} // sql.js 不支持 pragma，忽略
};

module.exports = { initDatabase, dbWrapper, saveDatabase };
