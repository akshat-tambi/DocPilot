import { EventEmitter } from 'node:events';
import type { MessagePort } from 'worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type {
  IngestionJobConfig,
  JobStatusPayload,
  PageResultPayload,
  WorkerEventMessage
} from '@docpilot/shared';
import { IngestionWorker } from '../src/ingestionWorker';

class FakePort extends EventEmitter {
  public messages: WorkerEventMessage[] = [];

  postMessage(message: WorkerEventMessage): void {
    this.messages.push(message);
  }

  close(): void {
    this.emit('close');
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  start(): void {
    // no-op for test stub
  }
}

type QueueStub = {
  add: Mock<[], Promise<void>>;
  clear: Mock<[], void>;
};

function createQueueStub(): QueueStub {
  return {
    add: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    clear: vi.fn<[], void>()
  };
}

function setupWorker(configOverride: Partial<IngestionJobConfig> = {}) {
  const port = new FakePort();
  const worker = new IngestionWorker(port as unknown as MessagePort);

  const baseConfig: IngestionJobConfig = {
    jobId: 'test-job',
    seedUrls: [],
    maxDepth: 1,
    maxPages: 5,
    followExternal: false
  };

  const config: IngestionJobConfig = { ...baseConfig, ...configOverride };
  const queue = createQueueStub();

  const jobState = {
    config,
    queue,
    visited: new Set<string>(),
    processedPages: 0,
    discoveredPages: 0,
    cancelled: false,
    hostAllowList: new Set(
      config.allowedDomains && config.allowedDomains.length > 0
        ? config.allowedDomains
        : ['example.com']
    )
  };

  (worker as unknown as { jobState: typeof jobState }).jobState = jobState;

  return { worker, port, jobState, queue };
}

function getPageResult(port: FakePort): PageResultPayload | undefined {
  const message = port.messages.find((event) => event.type === 'page-result') as
    | { type: 'page-result'; payload: PageResultPayload }
    | undefined;

  return message?.payload;
}

function getCancelledStatus(port: FakePort): JobStatusPayload | undefined {
  const message = port.messages.find(
    (event): event is { type: 'job-status'; payload: JobStatusPayload } =>
      event.type === 'job-status' && event.payload.status === 'cancelled'
  );

  return message?.payload;
}

describe('IngestionWorker queue orchestration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('increments processed pages and skips links beyond the max depth', async () => {
    const { worker, port, jobState, queue } = setupWorker({
      jobId: 'job-depth',
      maxDepth: 0,
      maxPages: 5
    });

    const workerAny = worker as unknown as {
      fetchAndParse: (url: string) => Promise<{ text: string; headings: string[]; links: string[] }>;
      processUrl(url: string, depth: number): Promise<void>;
    };

    vi.spyOn(workerAny, 'fetchAndParse').mockImplementation(async (url: string) => {
      if (url.endsWith('/root')) {
        return {
          text: 'Root content for testing',
          headings: ['Root'],
          links: ['https://example.com/depth1']
        };
      }

      return {
        text: 'Child content',
        headings: ['Child'],
        links: []
      };
    });

    await workerAny.processUrl('https://example.com/root', 0);

    expect(jobState.processedPages).toBe(1);
    expect(getPageResult(port)?.depth).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('cancels the job when the page limit is reached', async () => {
    const { worker, port, jobState, queue } = setupWorker({
      jobId: 'job-max-pages',
      maxDepth: 2,
      maxPages: 1
    });

    const workerAny = worker as unknown as {
      fetchAndParse: (url: string) => Promise<{ text: string; headings: string[]; links: string[] }>;
      cancelCurrentJob: (reason: string, jobId?: string) => void;
      processUrl(url: string, depth: number): Promise<void>;
    };

    vi.spyOn(workerAny, 'fetchAndParse').mockResolvedValue({
      text: 'Root content for testing',
      headings: ['Root'],
      links: ['https://example.com/child']
    });

    const cancelSpy = vi.spyOn(workerAny, 'cancelCurrentJob');

    await workerAny.processUrl('https://example.com/root', 0);

    expect(jobState.processedPages).toBe(1);
    expect(cancelSpy).toHaveBeenCalledWith('page-limit-reached', 'job-max-pages');
    expect(getCancelledStatus(port)?.error).toBe('page-limit-reached');
    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.clear).toHaveBeenCalled();
  });
});
