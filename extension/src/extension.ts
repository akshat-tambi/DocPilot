import * as vscode from 'vscode';

import type { IngestionJobConfig, WorkerEventMessage } from '@docpilot/shared';

import { WorkerManager } from './workerManager';
import { CopilotBridge } from './copilotBridge';
import { ContextAugmenter } from './contextAugmenter';
import { DocPilotSidebarProvider } from './sidebarProvider';

let workerManager: WorkerManager | null = null;
let copilotBridge: CopilotBridge | null = null;
let contextAugmenter: ContextAugmenter | null = null;
let activeJobId: string | null = null;
let activeQueryStatus: vscode.Disposable | null = null;

export function activate(context: vscode.ExtensionContext): void {
  // Initialize worker manager
  workerManager = new WorkerManager(context);
  context.subscriptions.push(workerManager);

  workerManager.on('message', handleWorkerMessage);
  workerManager.on('error', handleWorkerError);
  workerManager.on('exit', handleWorkerExit);

  // Register sidebar provider
  const sidebarProvider = new DocPilotSidebarProvider(context.extensionUri, workerManager, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DocPilotSidebarProvider.viewType, sidebarProvider)
  );

  // Initialize context augmenter (new UI-based approach)
  contextAugmenter = new ContextAugmenter(
    workerManager,
    vscode.window.createOutputChannel('DocPilot Context'),
    context
  );
  contextAugmenter.register(context);

  // Keep the original Copilot bridge for backward compatibility
  copilotBridge = new CopilotBridge(
    async (query: string) => {
      if (!workerManager) {
        throw new Error('Worker manager not available');
      }
      
      const result = await workerManager.query(query);
      return {
        chunks: result.chunks.map(chunk => ({
          chunk: {
            text: chunk.text,
            wordCount: chunk.text.split(' ').length
          },
          score: chunk.score,
          url: chunk.url,
          headings: chunk.headings
        })),
        totalFound: result.totalFound,
        queryTime: result.queryTime
      };
    },
    vscode.window.createOutputChannel('DocPilot Copilot')
  );

  copilotBridge.register(context);






}

export function deactivate(): void {
  workerManager?.dispose();
  
  workerManager = null;
  copilotBridge = null;
  contextAugmenter = null;
  activeJobId = null;
  
  if (activeQueryStatus) {
    activeQueryStatus.dispose();
    activeQueryStatus = null;
  }
}

function handleWorkerMessage(event: WorkerEventMessage): void {
  if (event.type === 'query-status') {
    if (activeQueryStatus) {
      activeQueryStatus.dispose();
      activeQueryStatus = null;
    }

    const status = event.payload.status;
    const jobScope = event.payload.jobId ? `job ${event.payload.jobId}` : 'all jobs';
    let message: string;

    switch (status) {
      case 'started':
        message = `DocPilot: query started for ${jobScope}`;
        break;
      case 'retrieving':
        message = `DocPilot: retrieving candidates (${event.payload.retrievedCandidates ?? 0} found)`;
        break;
      case 'scoring':
        message = `DocPilot: scoring ${event.payload.consideredChunks} chunks`;
        break;
      case 'completed':
        message = `DocPilot: query completed with ${event.payload.totalResults} results in ${event.payload.durationMs}ms`;
        break;
      case 'cancelled':
        message = 'DocPilot: query cancelled';
        break;
      case 'failed':
        message = `DocPilot: query failed (${event.payload.error})`;
        break;
    }

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      vscode.window.setStatusBarMessage(message, 5000);
    } else {
      activeQueryStatus = vscode.window.setStatusBarMessage(message);
    }

    return;
  }

  if (event.type === 'job-status') {
    if (event.payload.status === 'completed') {
      vscode.window.showInformationMessage(
        `DocPilot ingestion completed: ${event.payload.processedPages} pages processed.`
      );
      activeJobId = null;
      return;
    }

    if (event.payload.status === 'cancelled' || event.payload.status === 'error') {
      const reason = event.payload.error ? ` (${event.payload.error})` : '';
      vscode.window.showWarningMessage(
        `DocPilot ingestion ${event.payload.status}${reason}`
      );
      activeJobId = null;
    }

    return;
  }

  if (event.type === 'worker-error') {
    vscode.window.showErrorMessage(`DocPilot worker error: ${event.payload.message}`);
    if (activeQueryStatus) {
      activeQueryStatus.dispose();
      activeQueryStatus = null;
    }
  }
}

function handleWorkerError(error: Error): void {
  vscode.window.showErrorMessage(`DocPilot worker failed: ${error.message}`);
  activeJobId = null;
  if (activeQueryStatus) {
    activeQueryStatus.dispose();
    activeQueryStatus = null;
  }
}

function handleWorkerExit(code: number | null): void {
  const status = code === 0 ? 'stopped' : `exited with code ${code}`;
  vscode.window.showWarningMessage(`DocPilot worker ${status}.`);
  activeJobId = null;
  if (activeQueryStatus) {
    activeQueryStatus.dispose();
    activeQueryStatus = null;
  }
}
