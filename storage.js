// Extension-owned browser storage only. No chat/settings writes, no raw RP text.
export function hashKey(text) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${text.length}`;
}

export function messageKey(message) {
    return hashKey(JSON.stringify([message?.name, message?.send_date, message?.swipe_id ?? 0,
        message?.mes ?? '', message?.extra?.reasoning ?? '']));
}

const valid = range => Number.isFinite(range?.start) && Number.isFinite(range?.finish)
    && range.start > 0 && range.finish >= range.start;

export class TimingStore {
    constructor(storage, warn = console.warn) {
        this.storage = storage;
        this.warn = warn;
        this.warned = false;
        this.key = null;
        this.records = new Map();
    }

    select(identity) {
        const key = identity ? `st-message-metrics:v2:${hashKey(identity)}` : null;
        if (key === this.key) return;
        this.key = key;
        this.records = new Map();
        if (!key) return;
        try {
            const data = JSON.parse(this.storage?.getItem(key) ?? 'null');
            if (data?.version === 2 && Array.isArray(data.records)) {
                for (const entry of data.records.slice(-5000)) {
                    if (Array.isArray(entry) && typeof entry[0] === 'string' && valid(entry[1])) {
                        this.records.set(entry[0], entry[1]);
                    }
                }
            }
        } catch (error) { this.failed(error); }
    }

    get(message) { return this.records.get(messageKey(message)) ?? null; }

    set(message, range) {
        if (!this.key || !valid(range)) return;
        const key = messageKey(message), previous = this.records.get(key);
        if (previous?.start === range.start && previous?.finish === range.finish) return;
        this.records.delete(key);
        this.records.set(key, { start: range.start, finish: range.finish });
        while (this.records.size > 5000) this.records.delete(this.records.keys().next().value);
        try {
            if (!this.storage) throw new Error('Browser storage unavailable');
            this.storage.setItem(this.key, JSON.stringify({ version: 2, records: [...this.records] }));
        } catch (error) { this.failed(error); }
    }

    failed(error) {
        if (this.warned) return;
        this.warned = true;
        this.warn('[메시지 토큰·시간 표시] 브라우저 시간 저장 실패: 새로고침 후 보충 시간이 유지되지 않을 수 있습니다.', error);
    }
}
