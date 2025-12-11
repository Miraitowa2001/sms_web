/**
 * IoT设备 - 消息处理服务
 * 处理各种类型的推送消息
 */

const { dbWrapper: db } = require('./database');
const { getMessageTypeName, getMessageCategory, DEVICE_STATUS, SIM_STATUS } = require('./constants');
const pushService = require('./pushService');
const config = require('./config');

class MessageHandler {
    
    /**
     * 处理推送消息的主入口
     * @param {Object} data - 接收到的消息数据
     */
    handleMessage(data) {
        const { devId, type } = data;
        
        if (!devId || type === undefined) {
            console.warn('[Handler] 无效的消息数据:', data);
            return { success: false, error: '无效的消息数据' };
        }

        // 记录原始消息
        this.recordMessage(devId, type, data);

        // 根据消息类型分发处理
        const category = getMessageCategory(type);
        
        switch (category) {
            case 'network':
                return this.handleNetworkMessage(type, data);
            case 'sim':
                return this.handleSimMessage(type, data);
            case 'sms':
                return this.handleSmsMessage(type, data);
            case 'call':
                return this.handleCallMessage(type, data);
            case 'system':
                return this.handleSystemMessage(type, data);
            default:
                console.log(`[Handler] 收到消息 type=${type}: ${getMessageTypeName(type)}`);
                return { success: true };
        }
    }

    /**
     * 记录消息到数据库
     */
    recordMessage(devId, type, data) {
        // 如果配置为不保存原始消息，则直接返回
        if (!config.log || !config.log.saveRawMessages) {
            return;
        }

        try {
            const now = this.formatTime();
            const stmt = db.prepare(`
                INSERT INTO messages (dev_id, type, type_name, raw_data, created_at)
                VALUES (?, ?, ?, ?, ?)
            `);
            stmt.run(devId, type, getMessageTypeName(type), JSON.stringify(data), now);
        } catch (error) {
            console.error('[Handler] 记录消息失败:', error);
        }
    }

    /**
     * 处理网络联网消息 (100-102)
     */
    handleNetworkMessage(type, data) {
        const { devId, ip, ssid, dbm, hwVer, slotInfo } = data;
        
        console.log(`[Network] 设备 ${devId} ${getMessageTypeName(type)}, IP: ${ip}, SSID: ${ssid}`);

        // 更新或创建设备记录
        const existingDevice = db.prepare('SELECT id FROM devices WHERE dev_id = ?').get(devId);
        
        const now = this.formatTime();
        if (existingDevice) {
            const stmt = db.prepare(`
                UPDATE devices 
                SET last_ip = ?, last_ssid = ?, last_dbm = ?, hw_ver = ?,
                    status = ?, last_seen_at = ?, updated_at = ?
                WHERE dev_id = ?
            `);
            stmt.run(ip || '', ssid || '', dbm || 0, hwVer || '', DEVICE_STATUS.ONLINE, now, now, devId);
        } else {
            const stmt = db.prepare(`
                INSERT INTO devices (dev_id, last_ip, last_ssid, last_dbm, hw_ver, status, last_seen_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(devId, ip || '', ssid || '', dbm || 0, hwVer || '', DEVICE_STATUS.ONLINE, now, now, now);
        }

        // 如果有卡槽信息，更新SIM卡状态
        if (slotInfo) {
            this.updateSlotInfo(devId, slotInfo);
        }

        // 推送设备状态更新
        pushService.push('device_status', {
            devId,
            status: getMessageTypeName(type),
            ip: ip || 'unknown'
        });

        return { success: true };
    }

    /**
     * 处理SIM卡消息 (202-209)
     */
    handleSimMessage(type, data) {
        const { devId, slot, iccId, imsi, msIsdn, dbm, plmn } = data;
        
        console.log(`[SIM] 设备 ${devId} 卡槽${slot}: ${getMessageTypeName(type)}`);

        // 确保设备存在
        this.ensureDeviceExists(devId);

        let status = SIM_STATUS.UNKNOWN;
        switch (type) {
            case 202: status = SIM_STATUS.REGISTERING; break;
            case 203: // ID获取，状态保持
            case 204: status = SIM_STATUS.READY; break;
            case 205: status = SIM_STATUS.REMOVED; break;
            case 209: status = SIM_STATUS.ERROR; break;
        }

        // 更新或创建SIM卡记录
        const existingSim = db.prepare('SELECT id FROM sim_cards WHERE dev_id = ? AND slot = ?').get(devId, slot);
        const now = this.formatTime();
        
        if (existingSim) {
            const stmt = db.prepare(`
                UPDATE sim_cards 
                SET iccid = COALESCE(NULLIF(?, ''), iccid),
                    imsi = COALESCE(NULLIF(?, ''), imsi),
                    msisdn = COALESCE(NULLIF(?, ''), msisdn),
                    dbm = COALESCE(?, dbm),
                    plmn = COALESCE(NULLIF(?, ''), plmn),
                    status = ?,
                    updated_at = ?
                WHERE dev_id = ? AND slot = ?
            `);
            stmt.run(iccId || '', imsi || '', msIsdn || '', dbm ?? null, plmn || '', status, now, devId, slot);
        } else {
            const stmt = db.prepare(`
                INSERT INTO sim_cards (dev_id, slot, iccid, imsi, msisdn, dbm, plmn, status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(devId, slot, iccId || '', imsi || '', msIsdn || '', dbm || 0, plmn || '', status, now);
        }

        // 更新设备最后在线时间
        this.updateDeviceLastSeen(devId);

        // 推送SIM卡状态变更
        // 过滤掉 202 (注册中) 和 203 (ID已获取) 的推送，避免频繁打扰
        if (type !== 202 && type !== 203) {
            pushService.push('device_status', {
                devId,
                status: getMessageTypeName(type),
                detail: `卡槽${slot}状态变更: ${getMessageTypeName(type)}`
            });
        }

        return { success: true };
    }

    /**
     * 处理短信消息 (501-502)
     */
    handleSmsMessage(type, data) {
        // 兼容不同字段名：设备推送的字段为 phNum/smsBd/smsTs
        const devId = data.devId;
        const slot = data.slot;
        const phoneNumber = data.phoneNum || data.phNum || data.msIsdn || data.msisdn || '';
        const content = data.content || data.smsBd || '';
        const iccid = data.iccId || data.iccid || '';
        const imsi = data.imsi || '';
        const msisdn = data.msIsdn || data.msisdn || '';
        const netChannel = data.netCh;
        // 统一使用北京时间格式 YYYY-MM-DD HH:mm:ss
        const smsTime = this.formatTime(data.smsTs || data.time);
        
        // 区分接收和发送 (501: 接收, 502: 发送成功)
        const direction = type === 502 ? 'out' : 'in';
        const actionText = direction === 'out' ? '短信外发成功' : '收到短信';
        
        console.log(`[SMS] ${actionText}: ${phoneNumber} -> ${content}`);

        // 记录短信
        try {
            const stmt = db.prepare(`
                INSERT INTO sms_records (dev_id, slot, phone_num, content, sms_time, direction)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            stmt.run(devId, slot, phoneNumber || 'unknown', content || '', smsTime, direction);
        } catch (error) {
            console.error('[SMS] 记录短信失败:', error);
        }

        // 推送短信通知
        pushService.push('sms', {
            dev_id: devId,
            phone_num: phoneNumber,
            content: content,
            slot,
            iccid,
            imsi,
            msisdn,
            net_channel: netChannel,
            direction: direction
        });

        return { success: true };
    }

    /**
     * 处理电话消息 (601-642)
     */
    handleCallMessage(type, data) {
        // 兼容不同字段名
        const devId = data.devId;
        const slot = data.slot;
        const phoneNumber = data.phoneNum || data.phNum || data.msIsdn || data.msisdn || '';
        const callType = getMessageTypeName(type);
        
        // 计算时间与时长
        // telStartTs, telEndTs 是秒级时间戳
        // 统一使用北京时间格式 YYYY-MM-DD HH:mm:ss
        const startTime = this.formatTime(data.telStartTs || data.time);
        let duration = 0;
        if (data.telStartTs && data.telEndTs && data.telEndTs > data.telStartTs) {
            duration = data.telEndTs - data.telStartTs;
        }
        
        console.log(`[Call] 电话消息: ${phoneNumber} (${callType})`);

        // 记录通话
        try {
            // 注意：数据库字段为 start_time 而非 call_time
            const stmt = db.prepare(`
                INSERT INTO call_records (dev_id, slot, phone_num, msg_type, call_type, start_time, duration)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(devId, slot, phoneNumber || 'unknown', type, callType, startTime, duration);
        } catch (error) {
            console.error('[Call] 记录通话失败:', error);
        }

        // 仅在来电振铃(601)时推送通知，避免重复推送
        if (type === 601) {
            pushService.push('call', {
                dev_id: devId,
                phone_num: phoneNumber,
                call_type: callType,
                slot,
                net_channel: data.netCh
            });
        }

        return { success: true };
    }

    /**
     * 处理系统消息 (998 PING)
     */
    handleSystemMessage(type, data) {
        const { devId } = data;
        
        // PING消息，更新设备状态
        this.ensureDeviceExists(devId);
        this.updateDeviceLastSeen(devId);
        
        // PING 消息过于频繁，通常不推送，除非有特殊需求
        // 如果需要推送其他系统消息（如开机、重启），可以在这里添加判断
        if (type !== 998) {
            pushService.push('device_status', {
                devId,
                status: getMessageTypeName(type),
                detail: `系统消息: ${getMessageTypeName(type)}`
            });
        }
        
        console.log(`[System] 设备 ${devId} ${getMessageTypeName(type)}`);
        return { success: true };
    }

    /**
     * 确保设备记录存在
     */
    ensureDeviceExists(devId) {
        const existing = db.prepare('SELECT id FROM devices WHERE dev_id = ?').get(devId);
        if (!existing) {
            const now = this.formatTime();
            const stmt = db.prepare(`
                INSERT INTO devices (dev_id, status, last_seen_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `);
            stmt.run(devId, DEVICE_STATUS.ONLINE, now, now, now);
        }
    }

    /**
     * 更新设备最后在线时间
     */
    updateDeviceLastSeen(devId) {
        const now = this.formatTime();
        const stmt = db.prepare(`
            UPDATE devices 
            SET status = ?, last_seen_at = ?, updated_at = ?
            WHERE dev_id = ?
        `);
        stmt.run(DEVICE_STATUS.ONLINE, now, now, devId);
    }

    /**
     * 更新卡槽信息
     */
    updateSlotInfo(devId, slotInfo) {
        // slotInfo 格式解析 (根据文档格式处理)
        // 具体格式需要根据实际返回数据调整
    }

    /**
     * 格式化时间为 YYYY-MM-DD HH:mm:ss (北京时间)
     */
    formatTime(time) {
        let date;
        if (!time) {
            date = new Date();
        } else if (typeof time === 'number') {
            // 兼容秒级和毫秒级时间戳
            date = new Date(time < 10000000000 ? time * 1000 : time);
        } else {
            date = new Date(time);
        }

        if (isNaN(date.getTime())) {
            date = new Date();
        }

        // 转换为北京时间 (UTC+8)
        const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
        const beijingTime = new Date(utc + (3600000 * 8));
        
        const pad = n => n < 10 ? '0' + n : n;
        return `${beijingTime.getFullYear()}-${pad(beijingTime.getMonth() + 1)}-${pad(beijingTime.getDate())} ${pad(beijingTime.getHours())}:${pad(beijingTime.getMinutes())}:${pad(beijingTime.getSeconds())}`;
    }

    /**
     * 检查设备离线状态（定时任务调用）
     * @param {number} timeoutSeconds - 超时秒数
     */
    checkOfflineDevices(timeoutSeconds = 300) {
        // 计算超时阈值时间 (当前时间 - timeoutSeconds)
        const now = new Date();
        const thresholdTime = new Date(now.getTime() - timeoutSeconds * 1000);
        const thresholdStr = this.formatTime(thresholdTime);

        const stmt = db.prepare(`
            UPDATE devices 
            SET status = ?
            WHERE status = ? 
            AND last_seen_at < ?
        `);
        const result = stmt.run(DEVICE_STATUS.OFFLINE, DEVICE_STATUS.ONLINE, thresholdStr);
        
        if (result.changes > 0) {
            console.log(`[System] ${result.changes} 个设备标记为离线`);
        }
    }
}

module.exports = new MessageHandler();
