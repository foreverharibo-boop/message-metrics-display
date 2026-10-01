// Never let a stalled tokenizer block timer rendering or launch unlimited calls.
export class TokenJobs {
    constructor({ timeout = 8000, cooldown = 30000, timers = globalThis, now = Date.now } = {}) {
        this.timeout = timeout;
        this.cooldown = cooldown;
        this.timers = timers;
        this.now = now;
        this.active = new Map();
        this.inFlight = 0;
        this.failUntil = 0;
    }

    run(key, calculate) {
        if (this.active.has(key)) return this.active.get(key);
        if (this.inFlight >= 2 || this.now() < this.failUntil) return Promise.resolve(null);
        this.inFlight++;
        let timer;
        const task = new Promise(resolve => {
            let done = false;
            const finish = count => {
                if (done) return;
                done = true;
                this.timers.clearTimeout(timer);
                if (!(Number.isFinite(count) && count > 0)) this.failUntil = this.now() + this.cooldown;
                resolve(Number.isFinite(count) && count > 0 ? count : null);
            };
            timer = this.timers.setTimeout(() => finish(null), this.timeout);
            Promise.resolve().then(calculate).then(count => {
                this.inFlight--;
                finish(count);
            }, () => {
                this.inFlight--;
                finish(null);
            });
        }).finally(() => this.active.delete(key));
        this.active.set(key, task);
        return task;
    }
}
