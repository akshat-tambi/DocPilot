import { URL } from 'node:url';
import { parentPort, MessagePort } from 'node:worker_threads';

import {
  chunkText,
  summarizeChunks,
  type ChunkingOptions,
  type ChunkSummary,
  type IngestionJobConfig,
  type JobStatus,
  type JobStatusPayload,
  type PageProgressPayload,
  type PageResultPayload,
  type WorkerEventMessage,
  isWorkerControlMessage
} from '@docpilot/shared';
import { load as loadHtml } from 'cheerio';
import PQueue from 'p-queue';
import { fetch } from 'undici';
import type { Response } from 'undici';

import { RetrievalEngine } from './retrievalEngine';

type LinkCandidate = {
  href: string;
  depth: number;
};

type JobState = {
  config: IngestionJobConfig;
  queue: PQueue;
  visited: Set<string>;
  processedPages: number;
  discoveredPages: number;
  cancelled: boolean;
  hostAllowList: Set<string>;
};

type FetchResult = {
  text: string;
  headings: string[];
  links: string[];
};

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_USER_AGENT = 'DocPilotBot/0.1 (+https://github.com/akshat-tambi)';
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

export class IngestionWorker {
  private jobState: JobState | null = null;
  private retrievalEngine: RetrievalEngine;

  constructor(private readonly port: MessagePort) {
    this.retrievalEngine = new RetrievalEngine();
  }

  public async bind(): Promise<void> {
    await this.retrievalEngine.initialize();
    
    this.port.on('message', (message) => this.onMessage(message));
    this.port.on('close', () => {
      this.cancelCurrentJob('worker-port-closed');
      this.retrievalEngine.dispose();
    });
  }

  private onMessage(message: unknown): void {
    if (!isWorkerControlMessage(message)) {
      return;
    }

    if (message.type === 'start') {
      this.startJob(message.payload);
    } else if (message.type === 'cancel') {
      this.cancelCurrentJob('cancelled-by-extension', message.payload.jobId);
    } else if (message.type === 'query') {
      this.handleQuery(message.payload);
    }
  }

  private async handleQuery(payload: import('@docpilot/shared').QueryPayload): Promise<void> {
    try {
      const result = await this.retrievalEngine.retrieve({
        text: payload.query,
        limit: payload.limit || 10,
        jobIds: payload.jobId ? [payload.jobId] : undefined
      });

      const queryResult: import('@docpilot/shared').QueryResultPayload = {
        chunks: result.chunks.map(item => ({
          chunkId: item.chunk.id,
          url: item.url,
          headings: item.headings,
          text: item.chunk.text,
          score: item.score
        })),
        totalFound: result.totalFound,
        queryTime: result.queryTime
      };

      this.port.postMessage({
        type: 'query-result',
        payload: queryResult
      });
    } catch (error) {
      this.port.postMessage({
        type: 'worker-error',
        payload: {
          message: `Query failed: ${error instanceof Error ? error.message : String(error)}`
        }
      });
    }
  }

  private startJob(config: IngestionJobConfig): void {
    if (this.jobState && !this.jobState.cancelled) {
      this.emitJobStatus('error', {
        jobId: config.jobId,
        processedPages: this.jobState.processedPages,
        discoveredPages: this.jobState.discoveredPages,
        error: 'job_already_running'
      });
      return;
    }

    const queue = new PQueue({ concurrency: config.concurrency ?? DEFAULT_CONCURRENCY });
    const hostAllowList = new Set(
      (config.allowedDomains && config.allowedDomains.length > 0
        ? config.allowedDomains
        : config.seedUrls.map((url) => this.safeHostname(url))
      ).filter(Boolean) as string[]
    );

    this.jobState = {
      config,
      queue,
      visited: new Set<string>(),
      processedPages: 0,
      discoveredPages: 0,
      cancelled: false,
      hostAllowList
    };

    queue.onIdle().then(() => {
      if (!this.jobState || this.jobState.cancelled) {
        return;
      }

      this.emitJobStatus('completed', {
        jobId: config.jobId,
        processedPages: this.jobState.processedPages,
        discoveredPages: this.jobState.discoveredPages
      });
      this.jobState = null;
    });

    this.emitJobStatus('running', {
      jobId: config.jobId,
      processedPages: 0,
      discoveredPages: 0
    });

    config.seedUrls.forEach((url) => this.enqueueLink({ href: url, depth: 0 }));
  }

  private cancelCurrentJob(reason: string, jobId?: string): void {
    if (!this.jobState) {
      return;
    }

    const { config, queue } = this.jobState;
    if (jobId && config.jobId !== jobId) {
      return;
    }

    this.jobState.cancelled = true;
    queue.clear();

    this.emitJobStatus('cancelled', {
      jobId: config.jobId,
      processedPages: this.jobState.processedPages,
      discoveredPages: this.jobState.discoveredPages,
      error: reason
    });

    this.jobState = null;
  }

  private enqueueLink(candidate: LinkCandidate): void {
    if (!this.jobState || this.jobState.cancelled) {
      return;
    }

    const normalized = this.normalizeUrl(candidate.href);
    if (!normalized) {
      return;
    }

    const { jobState } = this;
    const { config, visited } = jobState;

    if (visited.has(normalized)) {
      return;
    }

    const depth = candidate.depth;
    if (depth > config.maxDepth) {
      return;
    }

    if (jobState.processedPages >= config.maxPages) {
      return;
    }

    const host = this.safeHostname(normalized);
    if (!host || !this.isDomainAllowed(host, jobState)) {
      return;
    }

    visited.add(normalized);
    jobState.discoveredPages += 1;

    this.emitPageProgress({
      jobId: config.jobId,
      url: normalized,
      depth,
      status: 'queued'
    });

    jobState.queue.add(async () => {
      await this.processUrl(normalized, depth);
    });
  }

  private async processUrl(url: string, depth: number): Promise<void> {
    if (!this.jobState || this.jobState.cancelled) {
      return;
    }

    const { config } = this.jobState;

    this.emitPageProgress({
      jobId: config.jobId,
      url,
      depth,
      status: 'fetching'
    });

    try {
      const result = await this.fetchAndParse(url, config);

      if (!result.text) {
        this.emitPageProgress({
          jobId: config.jobId,
          url,
          depth,
          status: 'skipped',
          reason: 'empty-content'
        });
        this.jobState.processedPages += 1;
        return;
      }

      const chunkOptions: ChunkingOptions = {
        jobId: config.jobId,
        url,
        tokensPerChunk: config.tokensPerChunk,
        overlapTokens: config.overlapTokens,
        minTokensPerChunk: config.minTokensPerChunk
      };

      const chunks = chunkText(result.text, chunkOptions);
      const summary = summarizeChunks(chunks);

      // Index chunks in vector store
      this.emitPageProgress({
        jobId: config.jobId,
        url,
        depth,
        status: 'embedding'
      });

      try {
        await this.retrievalEngine.indexChunks(config.jobId, url, chunks);
        
        this.emitPageProgress({
          jobId: config.jobId,
          url,
          depth,
          status: 'indexed'
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'embedding-failed';
        this.emitPageProgress({
          jobId: config.jobId,
          url,
          depth,
          status: 'failed',
          reason: `Embedding failed: ${reason}`
        });
        
        // Continue processing but log the error
        this.port.postMessage({
          type: 'worker-error',
          payload: {
            message: `Failed to embed chunks for ${url}: ${reason}`
          }
        });
        return;
      }

      const payload: PageResultPayload = {
        jobId: config.jobId,
        url,
        depth,
        headings: result.headings,
        rawText: result.text,
        chunks,
        summary: summary as ChunkSummary
      };

      this.emitPageResult(payload);
      this.emitPageProgress({
        jobId: config.jobId,
        url,
        depth,
        status: 'parsed'
      });

      const currentState = this.jobState;
      if (!currentState) {
        return;
      }

      currentState.processedPages += 1;

      if (currentState.cancelled) {
        return;
      }

      if (currentState.processedPages >= config.maxPages) {
        this.cancelCurrentJob('page-limit-reached', config.jobId);
        return;
      }

      result.links.forEach((href) => {
        this.enqueueLink({ href, depth: depth + 1 });
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown-error';
      this.emitPageProgress({
        jobId: config.jobId,
        url,
        depth,
        status: 'failed',
        reason
      });
      if (this.jobState) {
        this.jobState.processedPages += 1;
      }
    }
  }

  private async fetchAndParse(url: string, config: IngestionJobConfig): Promise<FetchResult> {
    const response = await this.fetchWithUserAgent(url, config.userAgent);

    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();

    if (this.isMarkdownUrl(url, contentType)) {
      return this.parseMarkdown(body);
    }

    if (contentType.includes('html')) {
      return this.parseHtml(url, body);
    }

    return {
      text: body,
      headings: [],
      links: []
    };
  }

  private async fetchWithUserAgent(url: string, userAgent?: string): Promise<Response> {
    return fetch(url, {
      headers: {
        'user-agent': userAgent ?? DEFAULT_USER_AGENT,
        accept: 'text/html, text/markdown;q=0.9, */*;q=0.8'
      }
    });
  }

  private parseHtml(url: string, html: string): FetchResult {
    const $ = loadHtml(html);

    const headings: string[] = [];
    $('h1, h2, h3')
      .slice(0, 20)
      .each((_, element) => {
        const text = $(element).text().trim();
        if (text) {
          headings.push(text);
        }
      });

    let mainText = '';
    const mainCandidates = ['main', 'article', '[role="main"]', '.content', '.markdown-body'];

    for (const selector of mainCandidates) {
      const candidateText = $(selector).text().trim();
      if (candidateText.length > mainText.length) {
        mainText = candidateText;
      }
    }

    if (!mainText) {
      mainText = $('body').text().trim();
    }

    const links = new Set<string>();
    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) {
        return;
      }

      const normalized = this.normalizeLink(href, url);
      if (normalized) {
        links.add(normalized);
      }
    });

    return {
      text: mainText,
      headings,
      links: Array.from(links)
    };
  }

  private async parseMarkdown(content: string): Promise<FetchResult> {
    const { unified } = await import('unified');
    const remarkParse = (await import('remark-parse')).default;
    const strip = (await import('strip-markdown')).default;
    const remarkStringify = (await import('remark-stringify')).default;

    const processor = unified().use(remarkParse as any).use(strip as any).use(remarkStringify as any);
    const file = await processor.process(content);
    const text = String(file).trim();

    return {
      text,
      headings: [],
      links: []
    };
  }

  private normalizeLink(href: string, baseUrl: string): string | null {
    try {
      const url = new URL(href, baseUrl);
      url.hash = '';
      url.searchParams.sort();
      return url.toString();
    } catch {
      return null;
    }
  }

  private normalizeUrl(rawUrl: string): string | null {
    try {
      const url = new URL(rawUrl);
      url.hash = '';
      url.searchParams.sort();
      return url.toString();
    } catch {
      return null;
    }
  }

  private safeHostname(rawUrl: string): string | null {
    try {
      return new URL(rawUrl).hostname;
    } catch {
      return null;
    }
  }

  private isDomainAllowed(hostname: string, jobState: JobState): boolean {
    if (jobState.config.followExternal) {
      return true;
    }

    return jobState.hostAllowList.has(hostname);
  }

  private isMarkdownUrl(url: string, contentType: string): boolean {
    if (contentType.includes('markdown')) {
      return true;
    }

    const lower = url.toLowerCase();
    return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  private emitPageProgress(payload: PageProgressPayload): void {
    this.postMessage({ type: 'page-progress', payload });
  }

  private emitPageResult(payload: PageResultPayload): void {
    this.postMessage({ type: 'page-result', payload });
  }

  private emitJobStatus(status: JobStatus, payload: Omit<JobStatusPayload, 'status'>): void {
    const message: WorkerEventMessage = {
      type: 'job-status',
      payload: { ...payload, status }
    };

    this.postMessage(message);
  }

  private postMessage(message: WorkerEventMessage): void {
    this.port.postMessage(message);
  }
}

if (parentPort) {
  const worker = new IngestionWorker(parentPort);
  worker.bind();
}
