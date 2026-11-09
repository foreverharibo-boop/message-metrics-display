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
            const payload = JSON.stringify({ version: 2, updatedAt: Date.now(), records: [...this.records] });
            this.prune(payload);
            this.storage.setItem(this.key, payload);
        } catch (error) { this.failed(error); }
    }

    prune(payload) {
        // This is a supplemental display cache, never a chat or native generation timestamp.
        if (!Number.isInteger(this.storage.length) || typeof this.storage.key !== 'function') return;
        const entries = [];
        let bytes = (this.key.length + payload.length) * 2;
        for (let i = 0; i < this.storage.length; i++) {
            const key = this.storage.key(i);
            if (!key?.startsWith('st-message-metrics:v2:') || key === this.key) continue;
            const raw = this.storage.getItem(key) || '';
            let at = 0; try { at = Number(JSON.parse(raw)?.updatedAt) || 0; } catch { /* Expire malformed own cache first. */ }
            const size = (key.length + raw.length) * 2;
            entries.push({key, at, size}); bytes += size;
        }
        entries.sort((a,b) => a.at - b.at);
        let count = entries.length + 1;
        for (const entry of entries) {
            if (count <= 100 && bytes <= 3 * 1024 * 1024) break;
            this.storage.removeItem(entry.key); count--; bytes -= entry.size;
        }
    }

    failed(error) {
        if (this.warned) return;
        this.warned = true;
        this.warn('[메시지 토큰·시간 표시] 브라우저 시간 저장 실패: 새로고침 후 보충 시간이 유지되지 않을 수 있습니다.', error);
    }
}
