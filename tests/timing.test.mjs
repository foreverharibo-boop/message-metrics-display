import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { GenerationTiming, storedGenerationRange, toMilliseconds, isInsteadSwipe } from '../timing.js';
import { TimingStore, hashKey } from '../storage.js';
import { TokenJobs } from '../token-jobs.js';

const epoch = 1800000000000;
const user = text => ({ is_user: true, mes: text });
const assistant = text => ({ is_user: false, mes: text });

test('ST Date·밀리초·초·문자열 형식을 읽고 누락/역전된 시간은 만들지 않는다', () => {
    for (const v of [new Date(epoch), epoch, epoch / 1000, String(epoch), new Date(epoch).toISOString()]) assert.equal(toMilliseconds(v), epoch);
    for (const v of [null, undefined, '', ' ', false, 'invalid', 0, -1]) assert.equal(toMilliseconds(v), null);
    assert.equal(storedGenerationRange({ gen_started: epoch + 3000, gen_finished: epoch }), null);
    assert.deepEqual(storedGenerationRange({ gen_started: new Date(epoch), gen_finished: epoch + 3000 }), { start: epoch, finish: epoch + 3000 });
});

test('quiet 본답변은 1.5초를 넘겨 늦게 들어와도 기록한 생성 시간을 표시한다', () => {
    const tracker = new GenerationTiming(), chat = [user('new turn')];
    tracker.started('quiet', {}, false, chat, epoch);
    tracker.finished(chat, epoch + 4000);
    chat.push(assistant('late public reply'));
    tracker.capture(1, chat, epoch + 15000);
    assert.deepEqual(tracker.range(chat[1]), { start: epoch, finish: epoch + 4000 });
});

test('외부 normal 생성 중 inner quiet/보조 생성이 시작돼도 시작 시각을 덮어쓰지 않는다', () => {
    const tracker = new GenerationTiming(), chat = [user('new turn')];
    tracker.userSent(chat, epoch);
    tracker.started('normal', {}, false, chat, epoch + 1000);
    tracker.started('quiet', {}, false, chat, epoch + 2000);
    chat.push(assistant('reply'));
    tracker.capture(1, chat, epoch + 3000);
    tracker.started('quiet', {}, false, chat, epoch + 3500);
    tracker.finished(chat, epoch + 5000);
    assert.deepEqual(tracker.range(chat[1]), { start: epoch, finish: epoch + 5000 });
});

test('배경 quiet만 실행한 뒤 예전 답변을 다시 렌더링해도 가짜 시간을 붙이지 않는다', () => {
    const tracker = new GenerationTiming(), chat = [user('old turn'), assistant('old reply')];
    tracker.started('quiet', {}, false, chat, epoch);
    tracker.finished(chat, epoch + 2000);
    tracker.capture(1, chat, epoch + 3000);
    assert.equal(tracker.range(chat[1]), null);
    assert.equal(tracker.range(chat[0]), null);
});

test('dry-run과 impersonate는 측정하지 않는다', () => {
    for (const [mode, options, dry] of [['normal', {}, true], ['quiet', { dryRun: true }, false], ['impersonate', {}, false]]) {
        const tracker = new GenerationTiming(), chat = [user('turn')];
        tracker.started(mode, options, dry, chat, epoch);
        chat.push(assistant('reply')); tracker.capture(1, chat, epoch + 2000);
        assert.equal(tracker.range(chat[1]), null);
    }
});

test('재생성·스와이프는 변경된 답변만 측정하고 각 스와이프의 저장 시각을 읽는다', () => {
    const tracker = new GenerationTiming(), chat = [user('turn'), assistant('old reply')];
    tracker.started('regenerate', {}, false, chat, epoch);
    tracker.capture(1, chat, epoch + 500);
    assert.equal(tracker.range(chat[1]), null);
    chat[1].mes = 'new reply'; tracker.finished(chat, epoch + 2000);
    assert.deepEqual(tracker.range(chat[1]), { start: epoch, finish: epoch + 2000 });
    chat[1].swipe_id = 1;
    tracker.started('swipe', {}, false, chat, epoch + 5000);
    chat[1].mes = 'swiped reply'; tracker.finished(chat, epoch + 8000);
    assert.deepEqual(tracker.range(chat[1]), { start: epoch + 5000, finish: epoch + 8000 });
    chat[1].swipe_id = 2; chat[1].swipe_info = [null, null, { gen_started: epoch + 10000, gen_finished: epoch + 18000 }];
    assert.deepEqual(tracker.range(chat[1]), { start: epoch + 10000, finish: epoch + 18000 });
});

test('채팅 전환과 새 사용자 턴은 다른 채팅·예전 턴의 시간을 재사용하지 않는다', () => {
    const tracker = new GenerationTiming(), chat = [user('turn')];
    tracker.started('normal', {}, false, chat, epoch);
    chat.push(assistant('reply')); tracker.finished(chat, epoch + 2000);
    tracker.reset();
    assert.equal(tracker.range(chat[1]), null);
    tracker.started('quiet', {}, false, chat, epoch + 5000);
    chat.push(user('next')); tracker.userSent(chat, epoch + 10000);
    tracker.started('quiet', {}, false, chat, epoch + 11000);
    chat.push(assistant('new reply')); tracker.finished(chat, epoch + 14000);
    assert.deepEqual(tracker.range(chat[3]), { start: epoch + 10000, finish: epoch + 14000 });
    assert.equal(tracker.range(chat[1]), null);
});

test('불변 채팅을 그대로 두며 메시지 인덱스 변경 후에도 해당 객체의 시간을 표시한다', () => {
    const tracker = new GenerationTiming();
    const chat = [Object.freeze(user('turn'))]; tracker.started('normal', {}, false, chat, epoch);
    const reply = Object.freeze(assistant('reply')); chat.push(reply); Object.freeze(chat);
    tracker.finished(chat, epoch + 2000);
    assert.deepEqual(tracker.range(reply), { start: epoch, finish: epoch + 2000 });
    assert.equal(Object.keys(reply).length, 2);
    const shifted = [Object.freeze(user('new earlier')), ...chat];
    assert.strictEqual(shifted[2], reply);
    assert.deepEqual(tracker.range(shifted[2]), { start: epoch, finish: epoch + 2000 });
});

test('실제 표시 코드: quiet·지연 렌더·native 슬롯 재사용·토큰 표시·native 재렌더 후 복구', async () => {
    class Element {
        constructor(className = '') {
            this.textContent = ''; this.title = ''; this.isConnected = true; this.children = [];
            const classes = new Set(className.split(' '));
            this.classList = { add: c => classes.add(c), contains: c => classes.has(c), remove: c => classes.delete(c) };
        }
        querySelector(selector) { return this.slots?.[selector] ?? null; }
        getAttribute(key) { return this.attrs?.[key] ?? null; }
        removeAttribute(key) { if (key === 'title') this.title = ''; }
        closest(selector) { return selector === '.mes_timer' && this.classList.contains('mes_timer') ? this : null; }
        matches() { return false; }
        append(el) { this.children.push(el); }
    }
    let now = epoch;
    class ClockedTiming extends GenerationTiming {
        started(type, params, dry, chat) { super.started(type, params, dry, chat, now); }
        userSent(chat) { super.userSent(chat, now); }
        finished(chat) { super.finished(chat, now); }
        capture(id, chat) { super.capture(id, chat, now); }
    }
    const listeners = new Map(), timers = new Map(); let counter = 0, observation;
    const events = Object.fromEntries(['MESSAGE_SENT','MESSAGE_RECEIVED','CHARACTER_MESSAGE_RENDERED','MESSAGE_UPDATED','MESSAGE_EDITED','MESSAGE_SWIPED','MORE_MESSAGES_LOADED','USER_MESSAGE_RENDERED','CHAT_CHANGED','CHAT_LOADED','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','APP_READY'].map(k => [k, k]));
    const nativeTimer = new Element('mes_timer'), token = new Element('tokenCounterDisplay'), wrapper = new Element('mesAvatarWrapper');
    const messageEl = new Element('mes'); messageEl.attrs = { mesid: '1' }; messageEl.slots = { '.mes_timer': nativeTimer, '.tokenCounterDisplay': token, '.mesAvatarWrapper': wrapper };
    const chat = [user('turn')], root = new Element();
    const document = { readyState: 'complete', querySelector: () => root, querySelectorAll: () => [messageEl], createElement: () => new Element(), addEventListener() {} };
    const context = { chat, chatId: 'persistence-test', characterId: 0, characters: [{ avatar: 'test.png' }] };
    const storageData = new Map();
    const localStorage = { getItem: key => storageData.get(key) ?? null, setItem: (key, value) => storageData.set(key, value) };
    const eventSource = { on(e, fn) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(fn); } };
    const emit = (event, ...args) => { for (const fn of listeners.get(event) ?? []) fn(...args); };
    let tokenCalls = 0;
    const sandbox = {
        eventSource, event_types: events, getContext: () => context, getTokenCountAsync: async () => { tokenCalls++; return 12; },
        GenerationTiming: ClockedTiming, storedGenerationRange, isInsteadSwipe, TimingStore, TokenJobs, hashKey, getCurrentUserHandle: () => 'test-user',
        document, HTMLElement: Element, Intl, Date, console,
        window: { localStorage, clearTimeout(id) { timers.delete(id); }, setTimeout(fn) { const id = ++counter; timers.set(id, fn); return id; } },
        MutationObserver: class { constructor(fn) { observation = fn; } observe() {} disconnect() {} },
    };
    const source = (await readFile(new URL('../index.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
    vm.runInNewContext(source + '\nglobalThis.testMetrics = { renderMessage, refreshVisibleMessages };', sandbox);
    emit('MESSAGE_SENT', 0); emit('GENERATION_STARTED', 'quiet', {}, false);
    now = epoch + 4000; emit('GENERATION_ENDED');
    now = epoch + 15000; chat.push(assistant('late reply'));
    emit('CHARACTER_MESSAGE_RENDERED', 1);
    await sandbox.testMetrics.renderMessage(messageEl);
    assert.equal(nativeTimer.textContent, '4.0s'); assert.equal(token.textContent, '12t');
    assert.equal(wrapper.children.length, 0, '원래 슬롯을 재사용해야 함');
    assert.equal(tokenCalls, 1);
    timers.clear(); nativeTimer.textContent = '';
    observation([{ target: nativeTimer, addedNodes: [] }]);
    assert.equal(timers.size, 1, 'ST가 시간 텍스트를 비운 뒤 복구 예약');
    await sandbox.testMetrics.refreshVisibleMessages();
    assert.equal(nativeTimer.textContent, '4.0s'); assert.equal(tokenCalls, 1);
    timers.clear(); observation([{ target: nativeTimer, addedNodes: [] }]);
    assert.equal(timers.size, 0, '자기 표시 작업 때문에 무한 갱신하면 안 됨');
    emit('CHAT_CHANGED'); await sandbox.testMetrics.renderMessage(messageEl);
    assert.equal(nativeTimer.textContent, '4.0s', '같은 채팅의 갱신으로 측정값을 지우면 안 됨');
    const reloadSandbox = { ...sandbox, eventSource: { on() {} } };
    context.chat = JSON.parse(JSON.stringify(chat));
    nativeTimer.textContent = '';
    vm.runInNewContext(source + '\nglobalThis.testMetrics = { renderMessage };', reloadSandbox);
    await reloadSandbox.testMetrics.renderMessage(messageEl);
    assert.equal(nativeTimer.textContent, '4.0s', '생성 이벤트가 없는 새 페이지 실행에서도 저장된 시간이 복구되어야 함');
    context.chat = [user('another chat'), assistant('old reply without timestamps')];
    emit('CHAT_CHANGED'); await sandbox.testMetrics.renderMessage(messageEl);
    assert.equal(nativeTimer.textContent, '', '기록 없는 이전 메시지의 시간을 만들어내면 안 됨');
    const previouslyNative = new Element('mes_timer'); previouslyNative.textContent = '8.5s';
    messageEl.slots['.mes_timer'] = previouslyNative;
    await sandbox.testMetrics.renderMessage(messageEl);
    assert.equal(previouslyNative.textContent, '8.5s', '이미 표시된 ST 원래 시간은 지우면 안 됨');
    // Exact inSTead non-streaming sequence: quiet completes, then a swipe with
    // equal timestamps is inserted, old message metrics remain, chat reloads.
    now = epoch + 30000;
    emit('GENERATION_STARTED', 'quiet', {}, false);
    now += 6000;
    emit('GENERATION_ENDED');
    const revised = JSON.parse(JSON.stringify(context.chat));
    revised[1].swipe_id = 1;
    revised[1].mes = 'inSTead revised output';
    revised[1].extra = { token_count: 999, instead_revised: true };
    revised[1].gen_started = epoch; revised[1].gen_finished = epoch + 2500;
    revised[1].swipe_info = [{}, { gen_started: now, gen_finished: now,
        extra: { api: 'inSTead', instead_revised: true } }];
    context.chat = revised;
    previouslyNative.textContent = '0.0s'; token.textContent = '999t';
    emit('CHAT_CHANGED');
    await sandbox.testMetrics.renderMessage(messageEl);
    assert.equal(previouslyNative.textContent, '6.0s', 'inSTead가 저장한 0초와 원본의 시각을 무시해야 함');
    assert.equal(token.textContent, '12t', '원본 토큰 999를 새 답변에 재사용하면 안 됨');
    const insteadReload = { ...sandbox, eventSource: { on() {} } };
    context.chat = JSON.parse(JSON.stringify(revised));
    previouslyNative.textContent = '0.0s';
    vm.runInNewContext(source + '\nglobalThis.testMetrics = { renderMessage };', insteadReload);
    await insteadReload.testMetrics.renderMessage(messageEl);
    assert.equal(previouslyNative.textContent, '6.0s', 'inSTead 보충 시간은 새로고침 후 복원되어야 함');
});
