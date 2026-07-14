const test = require('node:test');
const assert = require('node:assert/strict');
const {
    COMMANDS,
    calculateAdminToken,
    resolveCommand,
    mapCommandParams
} = require('../src/boardProtocol');

test('按新版固件规则生成管理员 token', () => {
    assert.equal(calculateAdminToken('admin'), '3f4bffa77257d243875d0a5a80635934');
});

test('命令别名解析为规范命令名', () => {
    assert.equal(resolveCommand('wifi'), 'wf');
    assert.equal(resolveCommand('addwifi'), 'addwf');
    assert.equal(resolveCommand('unknown'), null);
});

test('语义参数和原始 p 参数均能映射', () => {
    assert.deepEqual(mapCommandParams('sendsms', {
        slot: 1,
        phone: '10086',
        p3: '查话费',
        tid: 'sms-1'
    }), {
        command: 'sendsms',
        params: { p1: 1, p2: '10086', p3: '查话费', tid: 'sms-1' }
    });
});

test('包含 v137 文档新增的控制命令', () => {
    for (const command of [
        'pingintvl', 'slotpwr', 'readcard', 'writecard', 'storesmstelen',
        'telstartrecord', 'uploadamrlist', 'telamrplay', 'otanow'
    ]) assert.ok(COMMANDS[command], `缺少命令 ${command}`);
});

test('录音命令参数与当前文档一致', () => {
    assert.deepEqual(mapCommandParams('telstoprecord', { slot: 2, upload: 'on' }).params, { p1: 2, p2: 'on' });
    assert.deepEqual(mapCommandParams('telrecordupload', { filename: 'call_01.amr' }).params, { p1: 'call_01.amr' });
});
