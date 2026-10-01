import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { GenerationTiming } from './timing.js';

const EXTENSION_NAME = '메시지 토큰·시간 표시';
const TOKEN_CLASS = 'tokenCounterDisplay';
const TIMER_CLASS = 'mes_timer';
const VISIBLE_CLASS = 'st-message-metrics-visible';

/** @type {Map<string, { text: string, count: number }>} */
const tokenCache = new Map();

const generationTiming = new GenerationTiming();
const expectedTimerText = new WeakMap();

let observer = null;
let refreshTimer = null;
let refreshRunning = false;
let refreshRequested = false;
let initialized = false;
let currentChatIdentity = null;

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
    const range = generationTiming.range(message);

    if (!range) {
        // Keep a native ST timer that was already visible before our first
        // render, even if this build does not expose its timestamps.
        if (!expectedTimerText.has(element) && element.textContent?.trim()) return;
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

    setTimerText(element, `${seconds.toFixed(1)}s`);

    const storedTokens = Number(message?.extra?.token_count) || tokenCache.get(String(messageId))?.count || 0;
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

    const storedCount = Number(message?.extra?.token_count);
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
    const cached = tokenCache.get(cacheKey);
    if (cached?.text === text && cached.count > 0) {
        element.textContent = `${cached.count}t`;
        return;
    }

    try {
        const count = await getTokenCountAsync(text, 0);
        if (Number.isFinite(count) && count > 0) {
            tokenCache.set(cacheKey, { text, count });

            // The message may have been replaced while tokenization was running.
            const currentMessage = getChat()[messageId];
            if (currentMessage && makeTokenText(currentMessage) === text && messageElement.isConnected) {
                element.textContent = `${count}t`;
                renderTimer(messageElement, currentMessage, messageId);
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
        for (const messageElement of messageElements) {
            await renderMessage(messageElement);
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
    refreshTimer = window.setTimeout(() => void refreshVisibleMessages(), delay);
}

function resetForChat() {
    const context = getContext();
    const identity = {
        chat: context?.chat,
        key: JSON.stringify([context?.chatId, context?.characterId, context?.groupId]),
    };
    // Some extensions emit CHAT_CHANGED for updates within the same chat.
    // Such a refresh must not discard the current generation's timing.
    if (!currentChatIdentity || currentChatIdentity.chat !== identity.chat || currentChatIdentity.key !== identity.key) {
        tokenCache.clear();
        generationTiming.reset();
    }
    currentChatIdentity = identity;
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
                timer.textContent !== expectedTimerText.get(timer) || !timer.classList.contains(VISIBLE_CLASS)
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
