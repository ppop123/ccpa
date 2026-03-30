import { ProviderName } from "../providers/types";

export type UsageProvider = ProviderName | "unknown";

export interface UsageRecord {
  id: number;
  timestamp: string;
  provider: UsageProvider;
  endpoint: string;
  model: string | null;
  statusCode: number;
  success: boolean;
  stream: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageCounter {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastRequestAt: string | null;
}

export interface UsageSnapshot {
  totals: UsageCounter;
  providers: Record<string, UsageCounter>;
  endpoints: Record<string, UsageCounter>;
  models: Record<string, UsageCounter>;
  requestsByDay: Record<string, number>;
  requestsByHour: Record<string, number>;
  recentCount: number;
  generatedAt: string;
}

export interface UsageRecentSnapshot {
  items: UsageRecord[];
  generatedAt: string;
}

function createCounter(): UsageCounter {
  return {
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    lastRequestAt: null,
  };
}

function updateCounter(counter: UsageCounter, record: UsageRecord): void {
  counter.totalRequests += 1;
  counter.successCount += record.success ? 1 : 0;
  counter.failureCount += record.success ? 0 : 1;
  counter.inputTokens += record.inputTokens;
  counter.outputTokens += record.outputTokens;
  counter.totalTokens += record.totalTokens;
  counter.lastRequestAt = record.timestamp;
}

export class UsageTracker {
  private readonly totals = createCounter();
  private readonly providers = new Map<string, UsageCounter>();
  private readonly endpoints = new Map<string, UsageCounter>();
  private readonly models = new Map<string, UsageCounter>();
  private readonly requestsByDay = new Map<string, number>();
  private readonly requestsByHour = new Map<string, number>();
  private readonly recentRecords: UsageRecord[] = [];
  private nextId = 1;

  constructor(private readonly maxRecentRecords = 200) {}

  record(record: Omit<UsageRecord, "id" | "timestamp">): UsageRecord {
    const timestamp = new Date().toISOString();
    const fullRecord: UsageRecord = {
      id: this.nextId++,
      timestamp,
      ...record,
    };

    updateCounter(this.totals, fullRecord);
    updateCounter(this.getOrCreate(this.providers, fullRecord.provider), fullRecord);
    updateCounter(this.getOrCreate(this.endpoints, fullRecord.endpoint), fullRecord);

    if (fullRecord.model) {
      updateCounter(this.getOrCreate(this.models, fullRecord.model), fullRecord);
    }

    const dayKey = timestamp.slice(0, 10);
    const hourKey = timestamp.slice(11, 13);
    this.requestsByDay.set(dayKey, (this.requestsByDay.get(dayKey) || 0) + 1);
    this.requestsByHour.set(hourKey, (this.requestsByHour.get(hourKey) || 0) + 1);

    this.recentRecords.push(fullRecord);
    if (this.recentRecords.length > this.maxRecentRecords) {
      this.recentRecords.shift();
    }

    return fullRecord;
  }

  snapshot(): UsageSnapshot {
    return {
      totals: { ...this.totals },
      providers: this.toObject(this.providers),
      endpoints: this.toObject(this.endpoints),
      models: this.toObject(this.models),
      requestsByDay: Object.fromEntries(this.requestsByDay),
      requestsByHour: Object.fromEntries(this.requestsByHour),
      recentCount: this.recentRecords.length,
      generatedAt: new Date().toISOString(),
    };
  }

  recent(limit = 20): UsageRecentSnapshot {
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 20;
    return {
      items: [...this.recentRecords].reverse().slice(0, normalizedLimit),
      generatedAt: new Date().toISOString(),
    };
  }

  private getOrCreate(store: Map<string, UsageCounter>, key: string): UsageCounter {
    let counter = store.get(key);
    if (!counter) {
      counter = createCounter();
      store.set(key, counter);
    }
    return counter;
  }

  private toObject(store: Map<string, UsageCounter>): Record<string, UsageCounter> {
    return Object.fromEntries(
      [...store.entries()].map(([key, value]) => [key, { ...value }])
    );
  }
}
