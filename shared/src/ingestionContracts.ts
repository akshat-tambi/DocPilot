import type { TextChunk } from './chunking';

export interface IngestionJobConfig {
  jobId: string;
  seedUrls: string[];
  maxDepth: number;
  maxPages: number;
  followExternal: boolean;
  allowedDomains?: string[];
  userAgent?: string;
  tokensPerChunk?: number;
  overlapTokens?: number;
  minTokensPerChunk?: number;
  concurrency?: number;
}

export interface CancelJobPayload {
  jobId: string;
}

// Moved below to include query type

export type PageLifecycleStatus =
  | 'queued'
  | 'fetching'
  | 'parsed'
  | 'embedding'
  | 'indexed'
  | 'skipped'
  | 'failed';

export interface PageProgressPayload {
  jobId: string;
  url: string;
  depth: number;
  status: PageLifecycleStatus;
  reason?: string;
}

export interface ChunkSummary {
  totalChunks: number;
  totalWords: number;
  totalCharacters: number;
}

export interface PageResultPayload {
  jobId: string;
  url: string;
  depth: number;
  headings: string[];
  rawText: string;
  chunks: TextChunk[];
  summary: ChunkSummary;
}

export type JobStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'error';

export interface JobStatusPayload {
  jobId: string;
  status: JobStatus;
  processedPages: number;
  discoveredPages: number;
  error?: string;
}

export interface WorkerErrorPayload {
  message: string;
}

export interface QueryPayload {
  jobId?: string;
  query: string;
  limit?: number;
}

export type QueryStatus =
  | 'started'
  | 'retrieving'
  | 'scoring'
  | 'completed'
  | 'cancelled'
  | 'failed';

interface BaseQueryStatusPayload {
  queryId: string;
  jobId?: string;
  timestamp: number;
}

export type QueryStatusUpdatePayload =
  | (BaseQueryStatusPayload & {
      status: 'started';
      query: string;
    })
  | (BaseQueryStatusPayload & {
      status: 'retrieving';
      retrievedCandidates?: number;
    })
  | (BaseQueryStatusPayload & {
      status: 'scoring';
      consideredChunks: number;
    })
  | (BaseQueryStatusPayload & {
      status: 'completed';
      totalResults: number;
      durationMs: number;
    })
  | (BaseQueryStatusPayload & {
      status: 'cancelled';
    })
  | (BaseQueryStatusPayload & {
      status: 'failed';
      error: string;
    });

export interface QueryResultPayload {
  queryId: string;
  chunks: Array<{
    chunkId: string;
    url: string;
    headings: string[];
    text: string;
    score: number;
  }>;
  totalFound: number;
  queryTime: number;
}

export type WorkerControlMessage =
  | { type: 'start'; payload: IngestionJobConfig }
  | { type: 'cancel'; payload: CancelJobPayload }
  | { type: 'query'; payload: QueryPayload };

export type WorkerEventMessage =
  | { type: 'page-progress'; payload: PageProgressPayload }
  | { type: 'page-result'; payload: PageResultPayload }
  | { type: 'job-status'; payload: JobStatusPayload }
  | { type: 'query-status'; payload: QueryStatusUpdatePayload }
  | { type: 'query-result'; payload: QueryResultPayload }
  | { type: 'worker-error'; payload: WorkerErrorPayload };

export function isWorkerControlMessage(message: unknown): message is WorkerControlMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const value = message as { type?: unknown };
  if (value.type === 'start') {
    return true;
  }

  if (value.type === 'cancel') {
    return true;
  }

  return value.type === 'query';
}
