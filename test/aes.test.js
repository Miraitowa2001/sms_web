const test = require('node:test');
const assert = require('node:assert/strict');
const { decryptData, encryptData } = require('../src/aesDecrypt');

test('TCP双向AES数据可按开发板p字段格式加密和解密', () => {
    const config = { enabled: true, mode: 2, key: '1234567890123456', iv: '6543210987654321' };
    const source = { cmd: 'stat', tid: 'aes-1' };
    const encrypted = encryptData(source, config);
    assert.deepEqual(Object.keys(encrypted), ['p']);
    assert.deepEqual(decryptData(encrypted, config), source);
});

test('仅上行AES模式不会加密服务器下行命令', () => {
    const config = { enabled: true, mode: 1, key: '1234567890123456', iv: '6543210987654321' };
    const source = { cmd: 'stat' };
    assert.equal(encryptData(source, config), source);
});
