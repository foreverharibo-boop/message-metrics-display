import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';

const EXTENSION_NAME = '메시지 토큰·시간 표시';
const TOKEN_CLASS = 'tokenCounterDisplay';
const TIMER_CLASS = 'mes_timer';
const VISIBLE_CLASS = 'st-message-metrics-visible';

/** @type {Map<string, { text: string, count: number }>} */
const tokenCache = new Map();

/** @type {Map<string, { start: number, finish: number }>} */
const fallbackGenerationRanges = new Map();

/** @type {{ startedAt: number, finishedAt?: number, type?: string } | null} */
let activeGeneration = null;
let observer = null;
let refreshTimer = null;
let refreshRunning = false;
let refreshRequested = false;
let initialized = false;

function getChat() {
    try {
        return getContext()?.chat ?? [];
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] 채팅 정보를 읽지 못했습니다.`, error);
        return [];
    }
}

function toMilliseconds(value) {
    if (value instanceof Date) {
        return value.getTime();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 0 && value < 1e12 ? value * 1000 : value;
    }

    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
        }

        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }

    const coerced = Number(value);
    return Number.isFinite(coerced) && coerced > 0 ? coerced : null;
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

function getGenerationRange(message, messageId) {
    const storedStart = toMilliseconds(message?.gen_started);
    const storedFinish = toMilliseconds(message?.gen_finished);

    if (storedStart && storedFinish) {
        return { start: storedStart, finish: storedFinish };
    }

    return fallbackGenerationRanges.get(String(messageId)) ?? null;
}

function renderTimer(messageElement, message, messageId) {
    const element = getOrCreateMetricElement(messageElement, TIMER_CLASS);
    if (!element) {
        return;
    }

    element.classList.add(VISIBLE_CLASS);
    const range = getGenerationRange(message, messageId);

    if (!range) {
        if (!element.textContent?.trim()) {
            element.textContent = '';
            element.removeAttribute('title');
        }
        return;
    }

    const seconds = Math.max(0, (range.finish - range.start) / 1000);
    if (!Number.isFinite(seconds)) {
        return;
    }

    element.textContent = `${seconds.toFixed(1)}s`;

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
    tokenCache.clear();
    fallbackGenerationRanges.clear();
    activeGeneration = null;
    scheduleRefresh(80);
}

function onGenerationStarted(type, _params, isDryRun) {
    if (isDryRun || type === 'quiet' || type === 'impersonate') {
        return;
    }

    activeGeneration = {
        startedAt: Date.now(),
        type,
    };
    scheduleRefresh(0);
}

function onGenerationFinished() {
    if (activeGeneration) {
        activeGeneration.finishedAt = Date.now();
    }
    scheduleRefresh(0);

    // Keep the fallback timestamps briefly so a late render event can use them.
    window.setTimeout(() => {
        activeGeneration = null;
    }, 1500);
}

function onMessageReceived(messageId) {
    const numericId = Number(messageId);
    const message = Number.isInteger(numericId) ? getChat()[numericId] : null;

    if (message && !message.is_user && !message.is_system && activeGeneration?.startedAt) {
        const storedStart = toMilliseconds(message.gen_started);
        const storedFinish = toMilliseconds(message.gen_finished);

        if (!storedStart || !storedFinish) {
            fallbackGenerationRanges.set(String(numericId), {
                start: activeGeneration.startedAt,
                finish: activeGeneration.finishedAt ?? Date.now(),
            });
        }
    }

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
            for (const node of mutation.addedNodes) {
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

    observer.observe(chatElement, { childList: true, subtree: true });
}

function bindEvents() {
    const refreshEvents = [
        event_types.MESSAGE_SENT,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
        event_types.MORE_MESSAGES_LOADED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
    ];

    for (const eventName of refreshEvents.filter(Boolean)) {
        eventSource.on(eventName, () => scheduleRefresh());
    }

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

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
