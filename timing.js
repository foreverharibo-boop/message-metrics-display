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

export function storedGenerationRange(message) {
    const swipe = message?.swipe_info?.[Number(message.swipe_id)];
    for (const candidate of [swipe, message]) {
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
    constructor() { this.reset(); }

    reset() {
        this.ranges = new WeakMap();
        this.active = null;
        this.userTurn = null;
    }

    userSent(chat, now = Date.now()) {
        this.active = null;
        this.userTurn = { message: latestUser(chat), startedAt: now };
    }

    started(type, params, dryRun, chat, now = Date.now()) {
        const mode = String(type ?? 'normal').toLowerCase();
        if (dryRun || params?.dryRun || !['normal', 'regenerate', 'swipe', 'continue', 'quiet'].includes(mode)) return;
        const user = latestUser(chat);
        // Inner quiet generations and auxiliary requests must not reset an
        // outer main turn while it is awaiting its publicly displayed reply.
        if (mode === 'quiet' && this.active && this.active.user === user
            && (!this.active.bound || this.active.finishedAt === null)) return;
        this.active = {
            startedAt: this.userTurn?.message === user ? this.userTurn.startedAt : now,
            user,
            baseline: new Map(chat.filter(Boolean).map(m => [m, fingerprint(m)])),
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
        active.finishedAt = now;
        if (active.bound) {
            const { message, key } = active.bound;
            const range = this.ranges.get(message)?.get(key);
            if (range) range.finish = now;
        }
        const latest = chat.findLastIndex(visibleAssistant);
        if (latest >= 0) this.capture(latest, chat, now);
    }

    capture(id, chat, now = Date.now()) {
        const message = chat[id], active = this.active;
        if (!visibleAssistant(message) || !active || now - active.startedAt > 10 * 60 * 1000) return;
        const userIndex = active.user ? chat.indexOf(active.user) : -1;
        if (id < userIndex) return;
        if (active.bound && (active.bound.message !== message || active.bound.key !== variant(message))) return;
        if (!active.bound && active.baseline.get(message) === fingerprint(message)) return;
        if (storedGenerationRange(message)) return;
        const key = variant(message);
        let ranges = this.ranges.get(message);
        if (!ranges) { ranges = new Map(); this.ranges.set(message, ranges); }
        const existing = active.bound ? ranges.get(key) : null;
        ranges.set(key, { start: existing?.start ?? active.startedAt, finish: active.finishedAt ?? now });
        active.bound = { message, key };
    }

    range(message) {
        if (!visibleAssistant(message)) return null;
        return storedGenerationRange(message) ?? this.ranges.get(message)?.get(variant(message)) ?? null;
    }
}
