/** Simple token bucket: `rate` tokens per second, burst of `rate` (min 1). */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private rate: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = Math.max(1, rate);
    this.last = this.now();
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.1, rate);
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(Math.max(1, this.rate), this.tokens + elapsed * this.rate);
  }

  /** Milliseconds to wait before a token is available (0 if now). Consumes the token. */
  take(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const wait = ((1 - this.tokens) / this.rate) * 1000;
    this.tokens -= 1; // go negative: the caller waits `wait` ms
    return Math.ceil(wait);
  }

  async acquire(sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    const wait = this.take();
    if (wait > 0) await sleep(wait);
  }
}
