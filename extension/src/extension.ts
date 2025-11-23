import * as vscode from 'vscode';

import type { IngestionJobConfig, WorkerEventMessage } from '@docpilot/shared';

import { WorkerManager } from './workerManager';
import { CopilotBridge } from './copilotBridge';
import { ContextAugmenter } from './contextAugmenter';
import { DocPilotSidebarProvider } from './sidebarProvider';

let workerManager: WorkerManager | null = null;
let copilotBridge: CopilotBridge | null = null;
let contextAugmenter: ContextAugmenter | null = null;
let sidebarProviderInstance: DocPilotSidebarProvider | null = null;
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
  sidebarProviderInstance = sidebarProvider;
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

  // Listen for cursor and hover events to trigger doc suggestions
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(async (e) => {
      const editor = e.textEditor;
      const position = editor.selection.active;
      const document = editor.document;
      const wordRange = document.getWordRangeAtPosition(position);
      let symbol = '';
      if (wordRange) {
        symbol = document.getText(wordRange);
      }
      const startLine = Math.max(0, position.line - 3);
      const endLine = Math.min(document.lineCount - 1, position.line + 3);
      let contextLines = [];
      for (let i = startLine; i <= endLine; i++) {
        contextLines.push(document.lineAt(i).text);
      }
      const contextText = `${symbol}\n${contextLines.join('\n')}`.trim();
      if (workerManager && symbol) {
        try {
          const result = await workerManager.query(contextText, undefined, 3);
          if (contextAugmenter) {
            contextAugmenter.outputChannel.appendLine(`[selection] found ${result.chunks.length} docs for '${symbol}'`);
          }
        } catch (err) {
          if (contextAugmenter) {
            contextAugmenter.outputChannel.appendLine(`[selection] query error: ${err}`);
          }
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      provideHover: async (document, position, token) => {
        const wordRange = document.getWordRangeAtPosition(position);
        let symbol = '';
        if (wordRange) {
          symbol = document.getText(wordRange);
        }
        const startLine = Math.max(0, position.line - 3);
        const endLine = Math.min(document.lineCount - 1, position.line + 3);
        let contextLines = [];
        for (let i = startLine; i <= endLine; i++) {
          contextLines.push(document.lineAt(i).text);
        }
        const contextText = `${symbol}\n${contextLines.join('\n')}`.trim();
        if (workerManager && symbol) {
          try {
            const result = await workerManager.query(contextText, undefined, 3);
            if (result.chunks.length > 0) {
              // Send suggestions to sidebar
              if (sidebarProviderInstance && sidebarProviderInstance['_view']) {
                sidebarProviderInstance['_view'].webview.postMessage({
                  type: 'setDocSuggestions',
                  data: result.chunks.map(item => ({
                    heading: item.headings && item.headings.length > 0 ? item.headings.join(' > ') : '',
                    url: item.url,
                    text: item.chunk.text
                  }))
                });
              }
              const md = result.chunks.map((item, idx) => {
                let link = item.url ? `[source](${item.url})` : '';
                let heading = item.headings && item.headings.length > 0 ? item.headings.join(' > ') : '';
                return `**${heading}**\n${item.chunk.text}\n${link}`;
              }).join('\n---\n');
              return new vscode.Hover(new vscode.MarkdownString(md));
            }
          } catch (err) {
            if (contextAugmenter) {
              contextAugmenter.outputChannel.appendLine(`[hover] query error: ${err}`);
            }
          }
        }
        return undefined;
      }
    })
  );





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
