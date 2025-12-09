const { initDatabase, dbWrapper, saveDatabase } = require('./src/database');

async function fixDates() {
    console.log('正在初始化数据库...');
    await initDatabase();

    console.log('开始修复日期格式...');

    // 辅助函数：格式化时间
    function formatTime(time) {
        if (!time) return time;
        
        let date;
        // 尝试解析各种格式
        if (typeof time === 'number') {
            date = new Date(time < 10000000000 ? time * 1000 : time);
        } else if (/^\d+$/.test(time)) {
            const ts = parseInt(time);
            date = new Date(ts < 10000000000 ? ts * 1000 : ts);
        } else {
            date = new Date(time);
        }

        if (isNaN(date.getTime())) return time;

        // 转换为北京时间 (UTC+8)
        // 保持与 messageHandler.js 一致的逻辑
        const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
        const beijingTime = new Date(utc + (3600000 * 8));
        
        const pad = n => n < 10 ? '0' + n : n;
        return `${beijingTime.getFullYear()}-${pad(beijingTime.getMonth() + 1)}-${pad(beijingTime.getDate())} ${pad(beijingTime.getHours())}:${pad(beijingTime.getMinutes())}:${pad(beijingTime.getSeconds())}`;
    }

    // 修复 sms_records
    try {
        const smsRecords = dbWrapper.prepare('SELECT id, sms_time FROM sms_records').all();
        console.log(`找到 ${smsRecords.length} 条短信记录`);

        let smsFixedCount = 0;
        for (const record of smsRecords) {
            console.log(`当前短信时间: "${record.sms_time}"`);
            const newTime = formatTime(record.sms_time);
            console.log(`格式化后时间: "${newTime}"`);
            if (newTime && newTime !== record.sms_time) {
                // console.log(`修复短信时间: ${record.sms_time} -> ${newTime}`);
                dbWrapper.prepare('UPDATE sms_records SET sms_time = ? WHERE id = ?').run(newTime, record.id);
                smsFixedCount++;
            }
        }
        console.log(`修复了 ${smsFixedCount} 条短信记录`);
    } catch (e) {
        console.error('修复短信记录失败:', e);
    }

    // 修复 call_records
    try {
        const callRecords = dbWrapper.prepare('SELECT id, start_time FROM call_records').all();
        console.log(`找到 ${callRecords.length} 条通话记录`);

        let callFixedCount = 0;
        for (const record of callRecords) {
            const newTime = formatTime(record.start_time);
            if (newTime && newTime !== record.start_time) {
                // console.log(`修复通话时间: ${record.start_time} -> ${newTime}`);
                dbWrapper.prepare('UPDATE call_records SET start_time = ? WHERE id = ?').run(newTime, record.id);
                callFixedCount++;
            }
        }
        console.log(`修复了 ${callFixedCount} 条通话记录`);
    } catch (e) {
        console.error('修复通话记录失败:', e);
    }

    // 检查 devices 表
    try {
        const devices = dbWrapper.prepare('SELECT id, last_seen_at FROM devices').all();
        console.log(`找到 ${devices.length} 个设备`);
        let devFixedCount = 0;
        for (const dev of devices) {
            const newTime = formatTime(dev.last_seen_at);
            if (newTime && newTime !== dev.last_seen_at) {
                dbWrapper.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(newTime, dev.id);
                devFixedCount++;
            }
        }
        console.log(`修复了 ${devFixedCount} 个设备记录`);
    } catch (e) {
        console.error('检查设备表失败:', e);
    }

    // 检查 sim_cards 表
    try {
        const sims = dbWrapper.prepare('SELECT id, updated_at FROM sim_cards').all();
        console.log(`找到 ${sims.length} 个SIM卡记录`);
        let simFixedCount = 0;
        for (const sim of sims) {
            const newTime = formatTime(sim.updated_at);
            if (newTime && newTime !== sim.updated_at) {
                dbWrapper.prepare('UPDATE sim_cards SET updated_at = ? WHERE id = ?').run(newTime, sim.id);
                simFixedCount++;
            }
        }
        console.log(`修复了 ${simFixedCount} 个SIM卡记录`);
    } catch (e) {
        console.error('检查SIM卡表失败:', e);
    }

    saveDatabase();
    console.log('数据库修复完成并保存');
}

fixDates().catch(console.error);
