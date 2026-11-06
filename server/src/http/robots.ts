import robotsParser from 'robots-parser';

type Robot = ReturnType<typeof robotsParser>;

export type RobotsState = 'unknown' | 'allow-all' | 'rules' | 'unreachable';

export interface RobotsStatus {
  state: RobotsState;
  checkedAt: number | null;
  httpStatus: number | null;
  crawlDelaySec: number | null;
  error: string | null;
}

/**
 * robots.txt guard (RFC 9309 semantics): 2xx -> obey rules, 4xx -> no restrictions,
 * 5xx / unreachable -> assume everything is disallowed and retry later.
 */
export class RobotsGuard {
  private robot: Robot | null = null;
  status: RobotsStatus = { state: 'unknown', checkedAt: null, httpStatus: null, crawlDelaySec: null, error: null };

  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    private readonly agentToken: string,
    private readonly timeoutMs = 20_000,
  ) {}

  get url(): string {
    return `${this.baseUrl}/robots.txt`;
  }

  async refresh(): Promise<RobotsStatus> {
    const checkedAt = Date.now();
    try {
      const res = await fetch(this.url, {
        headers: { 'user-agent': this.userAgent, accept: 'text/plain,*/*;q=0.5' },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'follow',
      });
      const text = await res.text();
      if (res.ok) {
        this.robot = robotsParser(this.url, text);
        const delay = this.robot.getCrawlDelay(this.agentToken);
        this.status = { state: 'rules', checkedAt, httpStatus: res.status, crawlDelaySec: delay ?? null, error: null };
      } else if (res.status >= 400 && res.status < 500) {
        this.robot = null;
        this.status = { state: 'allow-all', checkedAt, httpStatus: res.status, crawlDelaySec: null, error: null };
      } else {
        this.robot = null;
        this.status = { state: 'unreachable', checkedAt, httpStatus: res.status, crawlDelaySec: null, error: `HTTP ${res.status}` };
      }
    } catch (e) {
      this.robot = null;
      this.status = { state: 'unreachable', checkedAt, httpStatus: null, crawlDelaySec: null, error: (e as Error).message };
    }
    return this.status;
  }

  isAllowed(url: string): boolean {
    switch (this.status.state) {
      case 'allow-all':
        return true;
      case 'rules':
        return this.robot!.isAllowed(url, this.agentToken) !== false;
      default:
        return false;
    }
  }

  /** Load rules from text (tests). */
  setRules(text: string): void {
    this.robot = robotsParser(this.url, text);
    this.status = {
      state: 'rules',
      checkedAt: Date.now(),
      httpStatus: 200,
      crawlDelaySec: this.robot.getCrawlDelay(this.agentToken) ?? null,
      error: null,
    };
  }
}
