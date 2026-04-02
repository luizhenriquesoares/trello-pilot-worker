const MAX_LOGS = 200;

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export class LogBuffer {
  private logs: LogEntry[] = [];

  add(level: LogEntry['level'], message: string): void {
    this.logs.unshift({
      timestamp: new Date().toISOString(),
      level,
      message,
    });
    if (this.logs.length > MAX_LOGS) {
      this.logs = this.logs.slice(0, MAX_LOGS);
    }
  }

  info(msg: string): void { this.add('info', msg); }
  warn(msg: string): void { this.add('warn', msg); }
  error(msg: string): void { this.add('error', msg); }

  getAll(): LogEntry[] {
    return this.logs;
  }

  /** Install as console override to capture all console.log/warn/error */
  install(): void {
    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      this.info(msg);
      origLog(...args);
    };

    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      this.warn(msg);
      origWarn(...args);
    };

    console.error = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      this.error(msg);
      origError(...args);
    };
  }
}
