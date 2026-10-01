// Display-only timing. Chat messages and generation requests are never changed.
export function toMilliseconds(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const numeric = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric > 0 ? numeric : null;
    if (typeof value !== 'string') return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function isInsteadSwipe(message) {
    return message?.swipe_info?.[Number(message.swipe_id)]?.extra?.api === 'inSTead';
}

export function storedGenerationRange(message) {
    const swipe = message?.swipe_info?.[Number(message.swipe_id)];
    if (isInsteadSwipe(message)) {
        const start = toMilliseconds(swipe?.gen_started), finish = toMilliseconds(swipe?.gen_finished);
        // inSTead non-streaming writes both timestamps AFTER generation.
        // The message-level timestamps/token_count still belong to the original.
        return start !== null && finish !== null && finish - start > 50 ? { start, finish } : null;
    }
    // The current message is updated first while streaming/continuing.
    for (const candidate of [message, swipe]) {
        const start = toMilliseconds(candidate?.gen_started), finish = toMilliseconds(candidate?.gen_finished);
        if (start !== null && finish !== null && finish >= start) return { start, finish };
    }
    return null;
}

const visibleAssistant = m => m && !m.is_user && !m.is_system && !m.is_hidden && m.role !== 'user' && m.role !== 'system';
const fingerprint = m => JSON.stringify([m?.swipe_id ?? null, m?.mes ?? '', m?.extra?.reasoning ?? '']);
const variant = m => String(m?.swipe_id ?? 'default');
const latestUser = chat => chat.findLast(m => m && (m.is_user || m.role === 'user') && !m.is_system);

export class GenerationTiming {
    constructor(onRecord = () => {}) { this.onRecord = onRecord; this.reset(); }

    reset() {
        this.ranges = new WeakMap();
        this.active = null;
        this.userTurn = null;
    }

    userSent(chat, now = Date.now()) {
        const user = latestUser(chat);
        // ST emits GENERATION_STARTED before inserting the user's message.
        if (this.active && !this.active.bound && this.active.finishedAt === null
            && this.active.mode === 'normal' && this.active.user !== user) {
            this.active.user = user;
            this.userTurn = null;
            return;
        }
        this.active = null;
        this.userTurn = { message: user, startedAt: now };
    }

    started(type, params, dryRun, chat, now = Date.now()) {
        const mode = String(type ?? 'normal').toLowerCase();
        if (dryRun || params?.dryRun || !['normal', 'regenerate', 'swipe', 'continue', 'quiet'].includes(mode)) return;
        const user = latestUser(chat);
        // Inner quiet generations and auxiliary requests must not reset an
        // outer main turn while it is awaiting its publicly displayed reply.
        if (mode === 'quiet' && this.active && this.active.user === user
            && this.active.finishedAt === null) return;
        this.active = {
            mode,
            startedAt: this.userTurn && this.userTurn.message === user ? this.userTurn.startedAt : now,
            user,
            baseline: new Map(chat.filter(Boolean).map(m => [m, fingerprint(m)])),
            baselineByIndex: new Map(chat.map((m, i) => [i, fingerprint(m)])),
            finishedAt: null,
            bound: null,
        };
        this.userTurn = null;
    }

    finished(chat, now = Date.now()) {
        const active = this.active;
        if (!active) return;
        // Retain the timing until a late reply is actually inserted. No 1.5s
        // cleanup timer can erase this or a subsequent generation's timing.
        active.finishedAt ??= now;
        if (active.bound) {
            const { message, key } = active.bound;
            const range = this.ranges.get(message)?.get(key);
            if (range) {
                range.finish = active.finishedAt;
                range.fingerprint = fingerprint(message);
                this.onRecord(message, { start: range.start, finish: range.finish });
            }
        }
        const latest = chat.findLastIndex(visibleAssistant);
        if (latest >= 0) this.capture(latest, chat, now);
    }

    capture(id, chat, now = Date.now()) {
        const message = chat[id], active = this.active;
        if (!visibleAssistant(message) || !active || now - active.startedAt > 60 * 60 * 1000) return;
        const userIndex = active.user ? chat.indexOf(active.user) : -1;
        if (id < userIndex && !isInsteadSwipe(message)) return;
        if (active.bound && (active.bound.message !== message || active.bound.key !== variant(message))) return;
        if (!active.bound && (active.baseline.get(message) === fingerprint(message)
            || (!active.baseline.has(message) && active.baselineByIndex.get(id) === fingerprint(message)))) return;
        if (storedGenerationRange(message)) return;
        const key = variant(message);
        let ranges = this.ranges.get(message);
        if (!ranges) { ranges = new Map(); this.ranges.set(message, ranges); }
        const existing = active.bound ? ranges.get(key) : null;
        const range = { start: existing?.start ?? active.startedAt, finish: active.finishedAt ?? now,
            fingerprint: fingerprint(message) };
        ranges.set(key, range);
        active.bound = { message, key };
        if (active.finishedAt !== null) this.onRecord(message, { start: range.start, finish: range.finish });
    }

    range(message) {
        if (!visibleAssistant(message)) return null;
        const stored = storedGenerationRange(message);
        if (stored) return stored;
        const range = this.ranges.get(message)?.get(variant(message));
        return range?.fingerprint === fingerprint(message) ? { start: range.start, finish: range.finish } : null;
    }
}
