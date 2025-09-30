import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { ExtensionContext, OutputChannel } from 'vscode';
import * as vscode from 'vscode';

import type {
  IngestionJobConfig,
  WorkerEventMessage,
  WorkerControlMessage,
  QueryResultPayload,
  QueryStatusUpdatePayload
} from '@docpilot/shared';

export type WorkerManagerEvents = {
  message: (event: WorkerEventMessage) => void;
  error: (error: Error) => void;
  exit: (code: number | null) => void;
};

export class WorkerManager extends EventEmitter implements vscode.Disposable {
  private worker: Worker | null = null;
  private readonly output: OutputChannel;

  constructor(private readonly context: ExtensionContext) {
    super();
    this.output = vscode.window.createOutputChannel('DocPilot Worker');
  }

  public override on<K extends keyof WorkerManagerEvents>(
    event: K,
    listener: WorkerManagerEvents[K]
  ): this {
    return super.on(event, listener);
  }

  public override once<K extends keyof WorkerManagerEvents>(
    event: K,
    listener: WorkerManagerEvents[K]
  ): this {
    return super.once(event, listener);
  }

  public override off<K extends keyof WorkerManagerEvents>(
    event: K,
    listener: WorkerManagerEvents[K]
  ): this {
    return super.off(event, listener);
  }

  public async ensureWorker(): Promise<void> {
    if (this.worker) {
      return;
    }

    const packagedWorkerEntry = path.join(this.context.extensionPath, 'runtime', 'worker', 'index.js');
    const devWorkerEntry = path.join(this.context.extensionPath, '..', 'worker', 'dist', 'index.js');
    const runtimeNodeModules = path.join(this.context.extensionPath, 'runtime', 'node_modules');

    const isPackaged = fs.existsSync(packagedWorkerEntry);
    const workerEntry = isPackaged && fs.existsSync(packagedWorkerEntry) ? packagedWorkerEntry : devWorkerEntry;

    const additionalNodePaths: string[] = [];
    if (isPackaged && fs.existsSync(runtimeNodeModules)) {
      additionalNodePaths.push(runtimeNodeModules);
    }

    this.output.appendLine(`[docpilot] starting worker: ${workerEntry} (packaged=${isPackaged})`);

    this.worker = new Worker(workerEntry, {
      execArgv: process.env.DOCPILOT_ENABLE_SOURCE_MAPS ? ['--enable-source-maps'] : [],
      workerData: {
        additionalNodePaths,
        isPackaged
      }
    });

    this.worker.on('message', (event: WorkerEventMessage) => {
      this.emit('message', event);
      this.logWorkerEvent(event);
    });

    this.worker.on('error', (error) => {
      this.output.appendLine(`[docpilot] worker error: ${error.message}`);
      this.emit('error', error);
      this.disposeWorker();
    });

    this.worker.on('exit', (code) => {
      this.output.appendLine(`[docpilot] worker exited with code ${code}`);
      this.emit('exit', code ?? null);
      this.disposeWorker();
    });
  }

  public async startIngestion(config: IngestionJobConfig): Promise<void> {
    await this.ensureWorker();

    if (!this.worker) {
      throw new Error('Worker failed to start');
    }

    const message: WorkerControlMessage = { type: 'start', payload: config };
    this.worker.postMessage(message);
  }

  public async query(query: string, jobId?: string, limit?: number): Promise<QueryResultPayload> {
    await this.ensureWorker();

    if (!this.worker) {
      throw new Error('Worker failed to start');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Query timeout'));
      }, 30000);

      const handleMessage = (event: WorkerEventMessage) => {
        if (event.type === 'query-result') {
          clearTimeout(timeout);
          this.off('message', handleMessage);
          resolve(event.payload);
        } else if (event.type === 'worker-error') {
          clearTimeout(timeout);
          this.off('message', handleMessage);
          reject(new Error(event.payload.message));
        }
      };

      this.on('message', handleMessage);

      const message: WorkerControlMessage = {
        type: 'query',
        payload: { query, jobId, limit }
      };
      this.worker!.postMessage(message);
    });
  }

  public async cancel(jobId: string): Promise<void> {
    if (!this.worker) {
      return;
    }

    const message: WorkerControlMessage = { type: 'cancel', payload: { jobId } };
    this.worker.postMessage(message);
  }

  public dispose(): void {
    this.disposeWorker();
    this.output.dispose();
  }

  private logWorkerEvent(event: WorkerEventMessage): void {
    if (event.type === 'worker-error') {
      this.output.appendLine(`[worker] error: ${event.payload.message}`);
      return;
    }

    if (event.type === 'job-status') {
      this.output.appendLine(
        `[worker] job ${event.payload.jobId} status ${event.payload.status} (processed=${event.payload.processedPages}, discovered=${event.payload.discoveredPages})`
      );
      return;
    }

    if (event.type === 'page-progress') {
      const status = event.payload.status;
      const emoji = status === 'indexed' ? '✅' : status === 'embedding' ? '🧠' : status === 'failed' ? '❌' : '📄';
      this.output.appendLine(
        `[worker] ${emoji} ${event.payload.url} (depth=${event.payload.depth}) ${status} ${event.payload.reason ?? ''}`
      );
      return;
    }

    if (event.type === 'page-result') {
      this.output.appendLine(
        `[worker] 📚 result ${event.payload.url} chunks=${event.payload.chunks.length} words=${event.payload.summary.totalWords}`
      );
      return;
    }

    if (event.type === 'query-status') {
      this.logQueryStatus(event.payload);
      return;
    }

    if (event.type === 'query-result') {
      this.output.appendLine(
        `[worker] 🔍 query ${event.payload.queryId} returned ${event.payload.chunks.length} results in ${event.payload.queryTime}ms`
      );
    }
  }

  private logQueryStatus(update: QueryStatusUpdatePayload): void {
    const prefix = `[worker] 🔄 query ${update.queryId} (${update.jobId ?? 'all'})`;
    switch (update.status) {
      case 'started':
        this.output.appendLine(`${prefix} started for "${update.query}"`);
        break;
      case 'retrieving':
        this.output.appendLine(
          `${prefix} retrieving${update.retrievedCandidates !== undefined ? ` candidates=${update.retrievedCandidates}` : ''}`
        );
        break;
      case 'scoring':
        this.output.appendLine(`${prefix} scoring considered=${update.consideredChunks}`);
        break;
      case 'completed':
        this.output.appendLine(`${prefix} completed results=${update.totalResults} duration=${update.durationMs}ms`);
        break;
      case 'cancelled':
        this.output.appendLine(`${prefix} cancelled`);
        break;
      case 'failed':
        this.output.appendLine(`${prefix} failed: ${update.error}`);
        break;
    }
  }

  private disposeWorker(): void {
    if (this.worker) {
      this.worker.terminate().catch(() => {
        // ignore terminate errors during disposal
      });
      this.worker.removeAllListeners();
      this.worker = null;
    }
  }
}
