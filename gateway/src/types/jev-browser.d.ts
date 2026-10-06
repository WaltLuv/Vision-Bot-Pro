// jev-browser 0.1.1 ships plain JavaScript. Only the surface the gateway uses is declared.
declare module 'jev-browser' {
  export class JevBrowser {
    constructor(browser: unknown, context: unknown, ownBrowser: boolean);
    page: any;
    stats: {calls: number; jev_ms: number; tokens: number};
    locate(i: number): any;
    act(act: {tool: string; target?: number | null; value?: unknown; key?: string; destination?: number}): Promise<number>;
    do(goal: string, opts?: {values?: Record<string, string>; maxActions?: number; allowIrreversible?: boolean; irreversibleAt?: number}): Promise<any>;
  }
}
