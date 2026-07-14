const crypto = require('crypto');

/**
 * X 系列开发板（v137 文档）HTTP 控制协议定义。
 * aliases 是 sms_web 对外暴露的语义化字段，最终会转换为开发板的 p1...pN。
 */
const COMMANDS = {
    now: { description: '设置开发板时间', params: { p1: ['time'], p2: ['auto'], p3: ['timezone'] } },
    stat: { description: '获取开发板状态', params: {} },
    restart: { description: '重启开发板', params: { p1: ['delay', 'seconds'] } },
    dailyrst: { description: '设置/查询每日重启时间', params: { p1: ['hour'] } },
    ping: { description: '设备在线响应测试', params: {} },
    pingintvl: { description: '设置/查询心跳间隔', params: { p1: ['seconds', 'interval'] } },
    chpwdadmin: { description: '修改管理员密码', params: { p1: ['oldPassword'], p2: ['newPassword'] } },
    chpwduser: { description: '修改用户密码', params: { p1: ['password', 'newPassword'] } },
    ackmax: { description: '设置/查询应答超时时间', params: { p1: ['milliseconds', 'timeout'] } },
    soundposstart: { description: '开始寻音定位', params: {} },
    soundposend: { description: '停止寻音定位', params: {} },
    storesmstelen: { description: '设置/查询短信和通话存储开关', params: { p1: ['slot'], p2: ['enabled', 'action'] } },
    factreset: { description: '恢复出厂设置', params: { p1: ['delay', 'seconds'] } },
    storesmstelclear: { description: '清空本地短信/通话数据库', params: { p1: ['scope'] } },

    slotrst: { description: '重启指定卡槽', params: { p1: ['slot'], p2: ['delay', 'seconds'] } },
    slotpwr: { description: '设置/查询卡槽电源', params: { p1: ['slot'], p2: ['enabled', 'action'] } },
    slotnet: { description: '设置/查询卡槽联网开关', params: { p1: ['slot'], p2: ['enabled', 'action'] } },
    readcard: { description: '读取 SIM 卡信息', params: { p1: ['slot'] } },
    writecard: {
        description: '写入 SIM 卡信息',
        params: {
            p1: ['slot'], p2: ['phone', 'phoneNumber'], p3: ['name'], p4: ['networkEnabled'],
            p5: ['monthlyTrafficMb'], p7: ['usedTrafficKb'], p9: ['trafficLowerPercent'],
            p10: ['trafficUpperPercent'], p11: ['incomingCount'], p12: ['incomingMinutes'],
            p13: ['outgoingCount'], p14: ['outgoingMinutes']
        }
    },

    wf: { description: '设置/查询 WiFi 模式', aliases: ['wifi'], params: { p1: ['mode', 'action'] } },
    addwf: { description: '增加 WiFi 热点', aliases: ['addwifi'], params: { p1: ['ssid'], p2: ['password'] } },
    delwf: { description: '删除 WiFi 热点', aliases: ['delwifi'], params: { p1: ['ssid'] } },
    askwfstore: { description: '查询已保存的 WiFi 网络', aliases: ['askwifistore'], params: {} },
    wftxdbm: { description: '设置/查询 WiFi 发射功率', aliases: ['wifitxdbm'], params: { p1: ['mode'], p2: ['power', 'percent'] } },

    sendsms: { description: '外发短信', params: { p1: ['slot'], p2: ['phone', 'phoneNumber'], p3: ['content'] } },
    storesmsen: { description: '设置/查询短信存储开关', params: { p1: ['slot'], p2: ['enabled', 'action'] } },
    querysms: { description: '查询本地短信库', params: { p1: ['offset'], p2: ['limit'], p3: ['keyword'], p4: ['slot'] } },

    teldial: {
        description: '电话拨号',
        params: {
            p1: ['slot'], p2: ['phone', 'phoneNumber'], p3: ['duration'], p4: ['tts'],
            p5: ['ttsCount'], p6: ['ttsInterval'], p7: ['afterTts'], p8: ['record'],
            p9: ['recordDuration'], p10: ['recordFilename'], p11: ['recordUpload']
        }
    },
    telanswer: {
        description: '接听来电',
        params: {
            p1: ['slot'], p2: ['duration'], p3: ['tts'], p4: ['ttsCount'], p5: ['ttsInterval'],
            p6: ['afterTts'], p7: ['record'], p8: ['recordDuration'], p9: ['recordFilename'], p10: ['recordUpload']
        }
    },
    telhangup: { description: '电话挂机', params: { p1: ['slot'] } },
    telkeypress: { description: '发送本地电话按键', params: { p1: ['slot'], p2: ['keys'], p3: ['durationMs'] } },
    telkeyclear: { description: '清除电话按键序列', params: { p1: ['slot'], p2: ['keyTid'] } },
    storetelen: { description: '设置/查询通话存储开关', params: { p1: ['slot'], p2: ['enabled', 'action'] } },
    querytel: { description: '查询本地通话记录', params: { p1: ['offset'], p2: ['limit'], p3: ['callType'], p4: ['phoneKeyword'], p5: ['slot'] } },

    telstarttts: { description: '播放 TTS 语音', params: { p1: ['slot'], p2: ['content', 'tts'], p3: ['count'], p4: ['interval'], p5: ['afterPlay'] } },
    telstoptts: { description: '停止播放 TTS', params: { p1: ['slot'], p2: ['afterStop'] } },
    telstartrecord: { description: '开始通话录音', params: { p1: ['slot'], p2: ['duration'], p3: ['filename'], p4: ['upload'] } },
    telstoprecord: { description: '停止通话录音', params: { p1: ['slot'], p2: ['upload'] } },
    telrecordupload: { description: '上传通话录音', params: { p1: ['filename'] } },
    uploadamrlist: { description: '列出 AMR 音频文件', params: {} },
    uploadamrremove: { description: '删除 AMR 音频文件', params: { p1: ['filename'] } },
    telamrplay: { description: '通话中播放 AMR 音频', params: { p1: ['slot'], p2: ['filename'] } },
    telamrstop: { description: '停止播放 AMR 音频', params: { p1: ['slot'] } },
    otanow: { description: '立即执行 OTA 升级', params: { p1: ['delay', 'seconds'] } }
};

const COMMAND_ALIASES = Object.entries(COMMANDS).reduce((result, [command, definition]) => {
    result[command] = command;
    for (const alias of definition.aliases || []) result[alias] = command;
    return result;
}, {});

function calculateAdminToken(password, username = 'admin') {
    return crypto.createHash('md5').update(`${username}|${password}`).digest('hex');
}

function resolveCommand(command) {
    return COMMAND_ALIASES[String(command || '').toLowerCase()] || null;
}

function mapCommandParams(command, input = {}) {
    const canonical = resolveCommand(command);
    if (!canonical) throw new Error(`不支持的开发板命令: ${command}`);

    const definition = COMMANDS[canonical];
    const params = {};
    for (const [protocolName, aliases] of Object.entries(definition.params)) {
        const candidates = [protocolName, ...aliases];
        const key = candidates.find(name => input[name] !== undefined && input[name] !== null && input[name] !== '');
        if (key) params[protocolName] = input[key];
    }
    if (input.tid !== undefined && input.tid !== null && input.tid !== '') params.tid = input.tid;
    return { command: canonical, params };
}

module.exports = { COMMANDS, calculateAdminToken, resolveCommand, mapCommandParams };
