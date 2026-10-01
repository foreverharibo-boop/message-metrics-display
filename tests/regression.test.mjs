import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationTiming, storedGenerationRange } from '../timing.js';
import { TimingStore } from '../storage.js';
import { TokenJobs } from '../token-jobs.js';

const epoch = 1800000000000;
const reply = () => ({ name: 'Character', send_date: '2026-10-01T12:00:00.000Z', is_user: false, swipe_id: 0, mes: 'private reply' });
const memoryStorage = () => {
    const data = new Map();
    return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('실제 ST 이벤트 순서로 측정한 시간이 새로운 인스턴스에서도 복원되고 채팅은 변경되지 않는다', () => {
    const storage = memoryStorage();
    const store = new TimingStore(storage);
    store.select('account/character/chat');
    const timing = new GenerationTiming((m, r) => store.set(m, r));
    const chat = [];
    timing.started('normal', {}, false, chat, epoch);
    chat.push(Object.freeze({ is_user: true, mes: 'hi' }));
    timing.userSent(chat, epoch + 100);
    const message = Object.freeze(reply());
    chat.push(message);
    const before = JSON.stringify(chat);
    timing.capture(1, chat, epoch + 2000);
    assert.equal(storage.data.size, 0, '진행 중 시간은 완료 기록으로 저장하지 않는다');
    timing.finished(chat, epoch + 4000);
    timing.finished(chat, epoch + 4500);
    assert.equal(JSON.stringify(chat), before);
    const reloaded = new TimingStore(storage);
    reloaded.select('account/character/chat');
    assert.deepEqual(reloaded.get(JSON.parse(JSON.stringify(message))), { start: epoch, finish: epoch + 4000 });
    assert.ok(![...storage.data.values()][0].includes('private reply'));
    reloaded.select('account/character/another-chat');
    assert.equal(reloaded.get(message), null);
    reloaded.select('another-account/character/chat');
    assert.equal(reloaded.get(message), null);
});

test('스와이프별 시간을 복원하고 수정된 본문에는 다른 시간 기록을 재사용하지 않는다', () => {
    const storage = memoryStorage(), store = new TimingStore(storage), message = reply();
    store.select('chat');
    store.set(message, { start: epoch, finish: epoch + 2000 });
    message.swipe_id = 1; message.mes = 'second';
    store.set(message, { start: epoch + 5000, finish: epoch + 9000 });
    const reload = new TimingStore(storage); reload.select('chat');
    assert.equal(reload.get(message).finish - reload.get(message).start, 4000);
    message.swipe_id = 0; message.mes = 'private reply';
    assert.equal(reload.get(message).finish - reload.get(message).start, 2000);
    message.mes = 'edited';
    assert.equal(reload.get(message), null);
});

test('저장소 차단·깨진 기록은 예외를 전파하지 않고 경고한다', () => {
    let warnings = 0;
    const store = new TimingStore({ getItem() { return '{broken'; }, setItem() { throw Error('quota'); } }, () => warnings++);
    store.select('chat');
    store.set(reply(), { start: epoch, finish: epoch + 1000 });
    assert.equal(warnings, 1);
    assert.equal(store.get(reply()).finish, epoch + 1000);
});

test('이어쓰기 중 현재 메시지의 시각이 예전 swipe_info보다 우선한다', () => {
    const message = { ...reply(), gen_started: epoch, gen_finished: epoch + 9000,
        swipe_info: [{ gen_started: epoch, gen_finished: epoch + 2000 }] };
    assert.equal(storedGenerationRange(message).finish, epoch + 9000);
});

test('토크나이저 시간 초과 후에도 호출 수가 제한되고 늦은 응답은 무시된다', async () => {
    let now = 0, resolveFirst, resolveSecond;
    const jobs = new TokenJobs({ timeout: 5, cooldown: 30, now: () => now });
    const a = jobs.run('a', () => new Promise(resolve => { resolveFirst = resolve; }));
    const b = jobs.run('b', () => new Promise(resolve => { resolveSecond = resolve; }));
    assert.equal(await jobs.run('c', () => { throw Error('must not run'); }), null);
    assert.deepEqual(await Promise.all([a, b]), [null, null]);
    now = 100;
    assert.equal(await jobs.run('d', () => { throw Error('unresolved calls remain capped'); }), null);
    resolveFirst(20); resolveSecond(30);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(await jobs.run('e', () => 42), 42);
});

test('quiet 완료 후 늦게 추가된 답변도 브라우저에 저장된다', () => {
    const storage = memoryStorage(), store = new TimingStore(storage);
    store.select('chat');
    const timing = new GenerationTiming((m, r) => store.set(m, r));
    const chat = [{ is_user: true, mes: 'hi' }];
    timing.started('quiet', {}, false, chat, epoch);
    timing.finished(chat, epoch + 5000);
    chat.push(reply());
    timing.capture(1, chat, epoch + 20000);
    const reload = new TimingStore(storage); reload.select('chat');
    assert.deepEqual(reload.get(chat[1]), { start: epoch, finish: epoch + 5000 });
});

test('완료된 배경 quiet 뒤 새 quiet 생성은 새로운 시작·종료 시각을 사용한다', () => {
    const timing = new GenerationTiming(), chat = [{ is_user: true, mes: 'hi' }];
    timing.started('quiet', {}, false, chat, epoch);
    timing.finished(chat, epoch + 1000);
    timing.started('quiet', {}, false, chat, epoch + 5000);
    timing.finished(chat, epoch + 9000);
    chat.push(reply()); timing.capture(1, chat, epoch + 10000);
    assert.deepEqual(timing.range(chat[1]), { start: epoch + 5000, finish: epoch + 9000 });
});
