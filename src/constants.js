/**
 * 消息类型常量定义
 */

// 消息类型定义
const MESSAGE_TYPES = {
    // 联网消息 (100-102)
    100: { name: 'WIFI已联网', category: 'network' },
    101: { name: '卡槽1已联网', category: 'network' },
    102: { name: '卡槽2已联网', category: 'network' },

    // SIM卡消息 (202-209)
    202: { name: 'SIM卡基站注册中', category: 'sim' },
    203: { name: 'SIM卡ID已获取', category: 'sim' },
    204: { name: 'SIM卡已就绪', category: 'sim' },
    205: { name: 'SIM卡已弹出', category: 'sim' },
    209: { name: 'SIM卡异常', category: 'sim' },

    // 通讯模组消息 (301)
    301: { name: '通讯模组错误', category: 'module' },

    // 命令应答消息 (401-402)
    401: { name: '命令已收到', category: 'command' },
    402: { name: '命令已处理', category: 'command' },

    // 短信消息 (501-502)
    501: { name: '新短信', category: 'sms' },
    502: { name: '短信外发成功', category: 'sms' },

    // 电话消息 (601-642)
    601: { name: '来电振铃', category: 'call' },
    602: { name: '来电接通', category: 'call' },
    603: { name: '对方挂断来电', category: 'call' },
    620: { name: '去电拨号中', category: 'call' },
    621: { name: '去电对方振铃中', category: 'call' },
    622: { name: '去电已接通', category: 'call' },
    623: { name: '去电已挂断', category: 'call' },
    641: { name: '通话中本地按键', category: 'call' },
    642: { name: '通话中远程按键', category: 'call' },

    // 电话控制回应消息 (681-689)
    681: { name: '外呼拨号成功', category: 'call_ctrl' },
    682: { name: '外呼拨号失败', category: 'call_ctrl' },
    684: { name: '接听成功', category: 'call_ctrl' },
    685: { name: '接听失败', category: 'call_ctrl' },
    687: { name: 'TTS播放成功', category: 'call_ctrl' },
    688: { name: 'TTS播放失败', category: 'call_ctrl' },
    689: { name: 'TTS播放结束', category: 'call_ctrl' },

    // 其它消息
    998: { name: 'PING心跳', category: 'system' }
};

// 获取消息类型名称
function getMessageTypeName(type) {
    const typeInfo = MESSAGE_TYPES[type];
    return typeInfo ? typeInfo.name : `未知消息(${type})`;
}

// 获取消息类型分类
function getMessageCategory(type) {
    const typeInfo = MESSAGE_TYPES[type];
    return typeInfo ? typeInfo.category : 'unknown';
}

// 设备状态
const DEVICE_STATUS = {
    ONLINE: 'online',
    OFFLINE: 'offline'
};

// SIM卡状态
const SIM_STATUS = {
    READY: 'ready',       // 就绪
    REGISTERING: 'registering', // 注册中
    ERROR: 'error',       // 异常
    REMOVED: 'removed',   // 已取出
    UNKNOWN: 'unknown'    // 未知
};

module.exports = {
    MESSAGE_TYPES,
    getMessageTypeName,
    getMessageCategory,
    DEVICE_STATUS,
    SIM_STATUS
};
