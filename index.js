import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { GenerationTiming, storedGenerationRange, isInsteadSwipe } from './timing.js';
import { getCurrentUserHandle } from '../../../user.js';
import { TimingStore, hashKey } from './storage.js';
import { TokenJobs } from './token-jobs.js';

const EXTENSION_NAME = '메시지 토큰·시간 표시';
const TOKEN_CLASS = 'tokenCounterDisplay';
const TIMER_CLASS = 'mes_timer';
const VISIBLE_CLASS = 'st-message-metrics-visible';

/** @type {Map<string, { text: string, count: number }>} */
const tokenCache = new Map();

let browserStorage = null;
try { browserStorage = window.localStorage; } catch (error) { console.warn(`[${EXTENSION_NAME}] 브라우저 저장소 접근 불가`, error); }
const timingStore = new TimingStore(browserStorage);
const tokenJobs = new TokenJobs({ timers: window });
const generationTiming = new GenerationTiming((message, range) => timingStore.set(message, range));
const expectedTimerText = new WeakMap();

let observer = null;
let refreshTimer = null;
let refreshRunning = false;
let refreshRequested = false;
let initialized = false;
let currentChatIdentity = null;
let tokenModelKey = null;
let chatRevision = 0;

function tokenizerIdentity() {
    const context = getContext();
    return JSON.stringify([context?.mainApi, context?.getTokenizerModel?.(),
        context?.powerUserSettings?.tokenizer, context?.textCompletionSettings?.type,
        context?.onlineStatus]);
}

function chatIdentity(context) {
    if (!context?.chatId) return null;
    const character = context.characters?.[context.characterId];
    return JSON.stringify([getCurrentUserHandle(), context.groupId ? 'group' : 'character',
        context.groupId || character?.avatar || context.characterId, context.chatId]);
}

function getChat() {
    try {
        return getContext()?.chat ?? [];
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] 채팅 정보를 읽지 못했습니다.`, error);
        return [];
    }
}

function formatDateTime(milliseconds) {
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour12: false,
    }).format(date).replace(',', '');
}

function getOrCreateMetricElement(messageElement, className) {
    let element = messageElement.querySelector(`.${className}`);
    if (element) {
        return element;
    }

    const wrapper = messageElement.querySelector('.mesAvatarWrapper');
    if (!wrapper) {
        return null;
    }

    element = document.createElement('div');
    element.className = className;
    wrapper.append(element);
    return element;
}

function makeTokenText(message) {
    const reasoning = typeof message?.extra?.reasoning === 'string' ? message.extra.reasoning : '';
    const body = typeof message?.mes === 'string' ? message.mes : '';
    return reasoning + body;
}

function storedTokenCount(message) {
    return Number(isInsteadSwipe(message)
        ? message.swipe_info[Number(message.swipe_id)]?.extra?.token_count
        : message?.extra?.token_count);
}

function setTimerText(element, text) {
    expectedTimerText.set(element, text);
    if (element.textContent !== text) element.textContent = text;
}

function renderTimer(messageElement, message, messageId) {
    const element = getOrCreateMetricElement(messageElement, TIMER_CLASS);
    if (!element) {
        return;
    }

    element.classList.add(VISIBLE_CLASS);
    generationTiming.capture(messageId, getChat());
    const range = generationTiming.range(message) ?? timingStore.get(message);

    if (!range) {
        // Keep a native ST timer that was already visible before our first
        // render, even if this build does not expose its timestamps.
        if (!isInsteadSwipe(message) && !expectedTimerText.has(element) && element.textContent?.trim()) return;
        // Never invent an elapsed time for an old message with no records.
        // Also clear a timer left behind by another swipe in the same DOM slot.
        setTimerText(element, '');
        element.removeAttribute('title');
        return;
    }

    const seconds = Math.max(0, (range.finish - range.start) / 1000);
    if (!Number.isFinite(seconds)) {
        return;
    }

    const text = `${seconds.toFixed(1)}s`;
    // Preserve native ST's richer tooltip (reasoning/TTFT), and avoid fighting
    // another extension that deliberately fills this same display slot.
    const previous = expectedTimerText.get(element);
    if (!isInsteadSwipe(message) && element.textContent?.trim()
        && element.textContent !== previous && element.textContent !== text) return;
    const preserveTitle = element.textContent === text && element.title
        && (storedGenerationRange(message) || element.textContent !== previous);
    setTimerText(element, text);
    if (preserveTitle) return;

    const storedTokens = storedTokenCount(message) || tokenCache.get(String(messageId))?.count || 0;
    const lines = [
        `Generation queued: ${formatDateTime(range.start)}`,
        `Reply received: ${formatDateTime(range.finish)}`,
        `Time to generate: ${seconds} seconds`,
    ];

    if (storedTokens > 0 && seconds > 0) {
        lines.push(`Token rate: ${(storedTokens / seconds).toFixed(3)} t/s`);
    }

    element.title = lines.join('\n');
}

async function renderTokens(messageElement, message, messageId) {
    const element = getOrCreateMetricElement(messageElement, TOKEN_CLASS);
    if (!element) {
        return;
    }

    element.classList.add(VISIBLE_CLASS);

    const storedCount = storedTokenCount(message);
    if (Number.isFinite(storedCount) && storedCount > 0) {
        element.textContent = `${storedCount}t`;
        return;
    }

    const text = makeTokenText(message);
    if (!text) {
        element.textContent = '';
        return;
    }

    const cacheKey = String(messageId);
    const model = tokenizerIdentity();
    if (tokenModelKey !== model) {
        tokenCache.clear();
        tokenModelKey = model;
    }
    const cached = tokenCache.get(cacheKey);
    if (cached?.text === text && cached.count > 0) {
        element.textContent = `${cached.count}t`;
        return;
    }

    try {
        const revision = chatRevision;
        const originalChat = getChat();
        const swipe = message.swipe_id;
        const count = await tokenJobs.run(`${revision}:${model}:${hashKey(text)}`, () => getTokenCountAsync(text, 0));
        if (Number.isFinite(count) && count > 0) {
            // The message may have been replaced while tokenization was running.
            const currentMessage = getChat()[messageId];
            if (revision === chatRevision && originalChat === getChat() && currentMessage === message
                && currentMessage.swipe_id === swipe && tokenizerIdentity() === model
                && Number(messageElement.getAttribute('mesid')) === messageId
                && makeTokenText(currentMessage) === text && messageElement.isConnected) {
                tokenCache.set(cacheKey, { text, count });
                element.textContent = `${count}t`;
                renderTimer(messageElement, currentMessage, messageId);
                scheduleRefresh(80);
            }
        }
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] #${messageId} 토큰 계산에 실패했습니다.`, error);
    }
}

async function renderMessage(messageElement) {
    if (!(messageElement instanceof HTMLElement)) {
        return;
    }

    const messageId = Number(messageElement.getAttribute('mesid'));
    if (!Number.isInteger(messageId) || messageId < 0) {
        return;
    }

    const message = getChat()[messageId];
    if (!message) {
        return;
    }

    renderTimer(messageElement, message, messageId);
    await renderTokens(messageElement, message, messageId);
}

async function refreshVisibleMessages() {
    if (refreshRunning) {
        refreshRequested = true;
        return;
    }

    refreshRunning = true;
    try {
        const messageElements = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
        // All timers render immediately. Token jobs are independently bounded.
        for (const messageElement of messageElements) {
            const id = Number(messageElement.getAttribute('mesid'));
            const message = Number.isInteger(id) && id >= 0 ? getChat()[id] : null;
            if (!message) continue;
            renderTimer(messageElement, message, id);
            void renderTokens(messageElement, message, id);
        }
    } finally {
        refreshRunning = false;
        if (refreshRequested) {
            refreshRequested = false;
            scheduleRefresh(0);
        }
    }
}

function scheduleRefresh(delay = 40) {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void refreshVisibleMessages().catch(error => {
        console.warn(`[${EXTENSION_NAME}] 표시 갱신 실패`, error);
    }), delay);
}

function resetForChat() {
    const context = getContext();
    const identity = {
        chat: context?.chat,
        key: chatIdentity(context),
    };
    // inSTead adds the swipe, saves, then reloads the chat rather than emitting
    // MESSAGE_RECEIVED. Capture before resetting object-based timing state.
    if (currentChatIdentity?.key && currentChatIdentity.key === identity.key) {
        for (let id = 0; id < (context?.chat?.length ?? 0); id++) {
            if (isInsteadSwipe(context.chat[id])) generationTiming.capture(id, context.chat);
        }
    }
    // Some extensions emit CHAT_CHANGED for updates within the same chat.
    // Such a refresh must not discard the current generation's timing.
    if (!currentChatIdentity || currentChatIdentity.chat !== identity.chat || currentChatIdentity.key !== identity.key) {
        tokenCache.clear();
        generationTiming.reset();
        chatRevision++;
    }
    currentChatIdentity = identity;
    timingStore.select(identity.key);
    scheduleRefresh(80);
}

function onGenerationStarted(type, params, isDryRun) {
    generationTiming.started(type, params, isDryRun, getChat());
    scheduleRefresh(0);
}

function onGenerationFinished() {
    generationTiming.finished(getChat());
    scheduleRefresh(0);
}

function onMessageReceived(messageId) {
    const numericId = Number(messageId);
    if (Number.isInteger(numericId)) generationTiming.capture(numericId, getChat());
    scheduleRefresh();
}

function onUserMessageSent() {
    generationTiming.userSent(getChat());
    scheduleRefresh();
}

function startObserver() {
    observer?.disconnect();

    const chatElement = document.querySelector('#chat');
    if (!chatElement) {
        window.setTimeout(startObserver, 500);
        return;
    }

    observer = new MutationObserver((mutations) => {
        let foundMessage = false;

        for (const mutation of mutations) {
            const target = mutation.target instanceof HTMLElement ? mutation.target : mutation.target?.parentElement;
            const timer = target?.closest?.(`.${TIMER_CLASS}`);
            if (timer && expectedTimerText.has(timer) && (
                (!timer.textContent?.trim() && expectedTimerText.get(timer)) || !timer.classList.contains(VISIBLE_CLASS)
            )) {
                foundMessage = true;
                break;
            }
            for (const node of mutation.addedNodes ?? []) {
                if (!(node instanceof HTMLElement)) {
                    continue;
                }

                if (node.matches('.mes[mesid]') || node.querySelector('.mes[mesid]')) {
                    foundMessage = true;
                    break;
                }
            }

            if (foundMessage) {
                break;
            }
        }

        if (foundMessage) {
            scheduleRefresh(0);
        }
    });

    observer.observe(chatElement, { childList: true, characterData: true, attributes: true, attributeFilter: ['class'], subtree: true });
}

function bindEvents() {
    const refreshEvents = [
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
        event_types.MORE_MESSAGES_LOADED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_REASONING_EDITED,
        event_types.MESSAGE_REASONING_DELETED,
        event_types.MESSAGE_SWIPE_DELETED,
        event_types.CHATCOMPLETION_MODEL_CHANGED,
        event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.CONNECTION_PROFILE_LOADED,
        event_types.SETTINGS_UPDATED,
    ];

    for (const eventName of refreshEvents.filter(Boolean)) {
        eventSource.on(eventName, () => scheduleRefresh());
    }

    for (const eventName of [event_types.MESSAGE_RECEIVED, event_types.CHARACTER_MESSAGE_RENDERED].filter(Boolean)) {
        eventSource.on(eventName, onMessageReceived);
    }
    if (event_types.MESSAGE_SENT) eventSource.on(event_types.MESSAGE_SENT, onUserMessageSent);

    for (const eventName of [event_types.CHAT_CHANGED, event_types.CHAT_LOADED].filter(Boolean)) {
        eventSource.on(eventName, resetForChat);
    }

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);
}

function init() {
    if (initialized) {
        resetForChat();
        return;
    }

    initialized = true;
    resetForChat();
    bindEvents();
    startObserver();
    scheduleRefresh(0);
    console.info(`[${EXTENSION_NAME}] 활성화되었습니다.`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

eventSource.on(event_types.APP_READY, init);
