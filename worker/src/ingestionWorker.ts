import { randomUUID } from 'node:crypto';
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
  type QueryPayload,
  type QueryResultPayload,
  type QueryStatusUpdatePayload,
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

  constructor(private readonly port: MessagePort, private readonly storagePath?: string) {
    this.retrievalEngine = new RetrievalEngine();
  }

  public async bind(): Promise<void> {
    await this.retrievalEngine.initialize(this.storagePath);
    
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
    } else if (message.type === 'clear-cache') {
      this.handleClearCache();
    } else if (message.type === 'get-cache-stats') {
      this.handleGetCacheStats();
    }
  }

  private handleClearCache(): void {
    this.retrievalEngine.clearCache();
  }

  private handleGetCacheStats(): void {
    const stats = this.retrievalEngine.getCacheStats();
    this.port.postMessage({
      type: 'cache-stats',
      payload: stats
    });
  }

  private emitQueryStatus(payload: QueryStatusUpdatePayload): void {
    this.port.postMessage({
      type: 'query-status',
      payload
    });
  }

  private async handleQuery(payload: QueryPayload): Promise<void> {
    const queryId = randomUUID();
    const startedAt = Date.now();

    this.emitQueryStatus({
      status: 'started',
      queryId,
      jobId: payload.jobId,
      query: payload.query,
      timestamp: startedAt
    });

    try {
      // Use intelligent retrieval for better results
      const result = await this.retrievalEngine.intelligentRetrieve({
        text: payload.query,
        limit: payload.limit || 5, // Fewer results with LLM since they're higher quality
        jobIds: payload.jobId ? [payload.jobId] : undefined
      });

      this.emitQueryStatus({
        status: 'retrieving',
        queryId,
        jobId: payload.jobId,
        retrievedCandidates: result.totalFound,
        timestamp: Date.now()
      });

      this.emitQueryStatus({
        status: 'scoring',
        queryId,
        jobId: payload.jobId,
        consideredChunks: result.chunks.length,
        timestamp: Date.now()
      });

      // Send intelligent query result
      this.port.postMessage({
        type: 'intelligent-query-result',
        payload: {
          queryId,
          chunks: result.chunks,
          totalFound: result.totalFound,
          queryTime: result.queryTime,
          llmProcessingTime: result.llmProcessingTime,
          fromCache: result.fromCache
        }
      });

      this.emitQueryStatus({
        status: 'completed',
        queryId,
        jobId: payload.jobId,
        totalResults: result.totalFound,
        durationMs: Date.now() - startedAt,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('[IngestionWorker] Query failed:', error);
      
      this.emitQueryStatus({
        status: 'failed',
        queryId,
        jobId: payload.jobId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      });
      
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

    // Don't rely on queue.onIdle() - check completion after each page
    // The completion check will be done in processUrl when all pages are done

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
      console.log(`[DocPilot] Skipping invalid URL: ${candidate.href}`);
      return;
    }

    const { jobState } = this;
    const { config, visited } = jobState;

    if (visited.has(normalized)) {
      console.log(`[DocPilot] Skipping already visited: ${normalized}`);
      return;
    }

    const depth = candidate.depth;
    if (depth > config.maxDepth) {
      console.log(`[DocPilot] Skipping depth ${depth} > maxDepth ${config.maxDepth}: ${normalized}`);
      return;
    }

    if (jobState.processedPages >= config.maxPages) {
      console.log(`[DocPilot] Skipping, reached maxPages ${config.maxPages}: ${normalized}`);
      return;
    }

    const host = this.safeHostname(normalized);
    if (!host || !this.isDomainAllowed(host, jobState)) {
      console.log(`[DocPilot] Skipping disallowed domain ${host} (followExternal: ${config.followExternal}): ${normalized}`);
      return;
    }

    console.log(`[DocPilot] Enqueuing depth ${depth} (${jobState.discoveredPages + 1}/${config.maxPages}): ${normalized}`);
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

      // Emit updated job status
      this.emitJobStatus('running', {
        jobId: config.jobId,
        processedPages: currentState.processedPages,
        discoveredPages: currentState.discoveredPages
      });

      if (currentState.cancelled) {
        return;
      }

      if (currentState.processedPages >= config.maxPages) {
        console.log(`[DocPilot] Reached page limit (${config.maxPages}), completing job`);
        
        // Complete successfully when page limit is reached
        this.emitJobStatus('completed', {
          jobId: config.jobId,
          processedPages: currentState.processedPages,
          discoveredPages: currentState.discoveredPages
        });
        
        // Clean up
        currentState.cancelled = true;
        currentState.queue.clear();
        this.jobState = null;
        return;
      }

      console.log(`[DocPilot] Found ${result.links.length} links on ${url} at depth ${depth}`);
      if (result.links.length > 0 && depth < config.maxDepth) {
        console.log(`[DocPilot] Processing links for depth ${depth + 1} (maxDepth: ${config.maxDepth})`);
      }
      result.links.forEach((href) => {
        this.enqueueLink({ href, depth: depth + 1 });
      });

      // Check if job should complete (no more work to do)
      this.checkJobCompletion();
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
        
        // Emit updated job status
        this.emitJobStatus('running', {
          jobId: config.jobId,
          processedPages: this.jobState.processedPages,
          discoveredPages: this.jobState.discoveredPages
        });
        
        // Check if job should complete
        this.checkJobCompletion();
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

    // Extract headings with hierarchy
    const headings: string[] = [];
    $('h1, h2, h3, h4')
      .slice(0, 20)
      .each((_, element) => {
        const text = $(element).text().trim();
        if (text) {
          headings.push(text);
        }
      });

    // Find main content container
    let mainContainer = $('main, article, [role="main"], .content, .markdown-body, .documentation').first();
    if (mainContainer.length === 0) {
      mainContainer = $('body');
    }

    // Extract and format content with code preservation
    const textParts: string[] = [];
    
    // Process each child element to preserve structure
    mainContainer.find('*').each((_, element) => {
      const $el = $(element);
      const tagName = element.tagName?.toLowerCase();
      
      // Skip navigation, footer, sidebar elements
      if ($el.closest('nav, footer, aside, header, .sidebar, .menu, .navigation').length > 0) {
        return;
      }

      // Handle code blocks
      if (tagName === 'pre') {
        const codeEl = $el.find('code').first();
        const code = codeEl.length > 0 ? codeEl.text() : $el.text();
        const language = codeEl.attr('class')?.match(/language-(\w+)/)?.[1] || 
                        codeEl.attr('data-lang') || 
                        'text';
        
        // Format as markdown code block
        textParts.push(`\n\`\`\`${language}\n${code.trim()}\n\`\`\`\n`);
        
        // Remove to avoid duplication
        $el.remove();
      }
      // Handle inline code
      else if (tagName === 'code' && !$el.parent().is('pre')) {
        const code = $el.text().trim();
        if (code && code.length < 100) {
          $el.replaceWith(` \`${code}\` `);
        }
      }
      // Handle lists - preserve structure
      else if (tagName === 'li') {
        const text = $el.clone().children().remove().end().text().trim();
        if (text && !$el.parent().closest('nav').length) {
          textParts.push(`- ${text}`);
          $el.remove();
        }
      }
      // Handle paragraphs
      else if (tagName === 'p') {
        const text = $el.text().trim();
        if (text) {
          textParts.push(`${text}\n`);
          $el.remove();
        }
      }
      // Handle tables - convert to markdown-style
      else if (tagName === 'table') {
        const rows: string[] = [];
        $el.find('tr').each((i, row) => {
          const cells: string[] = [];
          $(row).find('th, td').each((_, cell) => {
            cells.push($(cell).text().trim());
          });
          if (cells.length > 0) {
            rows.push(`| ${cells.join(' | ')} |`);
            if (i === 0 && $(row).find('th').length > 0) {
              // Add header separator
              rows.push(`| ${cells.map(() => '---').join(' | ')} |`);
            }
          }
        });
        if (rows.length > 0) {
          textParts.push('\n' + rows.join('\n') + '\n');
        }
        $el.remove();
      }
      // Handle headings - preserve hierarchy
      else if (/^h[1-6]$/.test(tagName)) {
        const level = parseInt(tagName.charAt(1));
        const text = $el.text().trim();
        if (text) {
          textParts.push(`\n${'#'.repeat(level)} ${text}\n`);
          $el.remove();
        }
      }
    });

    // Get remaining text (not already processed)
    const remainingText = mainContainer.text().trim();
    if (remainingText) {
      textParts.push(remainingText);
    }

    // Combine all parts
    let mainText = textParts.join('\n').trim();
    
    // Clean up excessive whitespace while preserving code blocks
    mainText = mainText
      .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
      .replace(/ {2,}/g, ' '); // Normalize spaces

    // Extract links
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
    // For markdown, we want to preserve code blocks and structure
    // Instead of stripping everything, we'll do minimal processing
    
    const { unified } = await import('unified');
    const remarkParse = (await import('remark-parse')).default;
    const remarkStringify = (await import('remark-stringify')).default;

    // Parse markdown to AST
    const processor = unified()
      .use(remarkParse as any)
      .use(remarkStringify as any);
      
    const file = await processor.process(content);
    let text = String(file).trim();

    // Extract headings using regex
    const headings: string[] = [];
    const headingRegex = /^#{1,6}\s+(.+)$/gm;
    let match;
    while ((match = headingRegex.exec(content)) !== null) {
      headings.push(match[1].trim());
    }

    // Preserve code blocks in markdown format
    // Already in good format: ```language\ncode\n```
    
    // Clean up excessive whitespace while preserving code structure
    text = text
      .replace(/\n{4,}/g, '\n\n\n') // Max 3 newlines (preserve code block spacing)
      .trim();

    return {
      text,
      headings,
      links: [] // We don't extract links from markdown for now
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

  private checkJobCompletion(): void {
    if (!this.jobState || this.jobState.cancelled) {
      return;
    }

    // Use a small delay to ensure queue is truly idle and no more tasks are being added
    setTimeout(() => {
      if (!this.jobState || this.jobState.cancelled) {
        return;
      }

      const { queue, config } = this.jobState;
      
      // Job is complete when queue is idle AND no more pages will be processed
      if (queue.size === 0 && queue.pending === 0) {
        console.log(`[DocPilot] Job completing - processed: ${this.jobState.processedPages}, discovered: ${this.jobState.discoveredPages}`);
        
        this.emitJobStatus('completed', {
          jobId: config.jobId,
          processedPages: this.jobState.processedPages,
          discoveredPages: this.jobState.discoveredPages
        });
        this.jobState = null;
      }
    }, 100); // Small delay to let any remaining enqueuing finish
  }
}
