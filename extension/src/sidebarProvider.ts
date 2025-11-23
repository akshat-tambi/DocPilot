import * as vscode from 'vscode';
import { WorkerManager } from './workerManager';
import type { IngestionJobConfig } from '@docpilot/shared';

export interface DocumentSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastScraped: Date | null;
  status: 'idle' | 'scraping' | 'success' | 'error';
  jobId?: string;
  error?: string;
  config: {
    maxDepth: number;
    maxPages: number;
    followExternal: boolean;
  };
  stats?: {
    pagesScraped: number;
    chunksCreated: number;
  };
}

export interface UIState {
  sources: DocumentSource[];
  isAugmentationEnabled: boolean;
  maxContextChunks: number;
}

export class DocPilotSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'docpilot.main';

  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private state: UIState = {
    sources: [],
    isAugmentationEnabled: true,
    maxContextChunks: 3
  };

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workerManager: WorkerManager,
    private readonly _context: vscode.ExtensionContext
  ) {
    this.loadState().then(() => {
      if (this._view) {
        this.sendState();
      }
    });

    // Listen to worker events for real-time updates
    this._workerManager.on('message', this.handleWorkerMessage.bind(this));
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri
      ]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        if (message.type === 'pinSuggestion') {
          // For now, just log the pin action
          console.log('Pin suggestion', message.data);
          vscode.window.showInformationMessage('Pinned doc suggestion');
          return;
        }
        if (message.type === 'rateSuggestion') {
          // For now, just log the rating action
          console.log('Rate suggestion', message.data);
          vscode.window.showInformationMessage(`Rated doc suggestion: ${message.data.value > 0 ? '👍' : '👎'}`);
          return;
        }
        await this.handleMessage(message);
      },
      undefined,
      this._context.subscriptions
    );
  }

  private async handleMessage(message: any) {
    switch (message.type) {
      case 'addSource':
        await this.addSource(message.data);
        break;
      case 'removeSource':
        await this.removeSource(message.data.id);
        break;
      case 'toggleSource':
        await this.toggleSource(message.data.id);
        break;
      case 'startScraping':
        await this.startScraping(message.data.id);
        break;
      case 'updateSettings':
        await this.updateSettings(message.data);
        break;
      case 'getState':
        this.sendState();
        break;
    }
  }

  private async addSource(sourceData: { name?: string; url?: string; config?: { maxDepth?: number; maxPages?: number; followExternal?: boolean } }) {
    if (!sourceData.url) {
      vscode.window.showErrorMessage('URL is required');
      return;
    }

    const newSource: DocumentSource = {
      id: `source-${Date.now()}`,
      name: sourceData.name || new URL(sourceData.url!).hostname,
      url: sourceData.url!,
      enabled: true,
      lastScraped: null,
      status: 'idle',
      config: {
        maxDepth: sourceData.config?.maxDepth || 2,
        maxPages: sourceData.config?.maxPages || 25,
        followExternal: sourceData.config?.followExternal || false
      }
    };

    this.state.sources.push(newSource);
    await this.saveState();
    this.sendState();
  }

  private async removeSource(id: string) {
    const sourceIndex = this.state.sources.findIndex(s => s.id === id);
    if (sourceIndex !== -1) {
      const source = this.state.sources[sourceIndex];
      
      if (source.jobId && source.status === 'scraping') {
        try {
          await this._workerManager.cancel(source.jobId);
        } catch (error) {
          console.error('Failed to cancel job:', error);
        }
      }
      
      this.state.sources.splice(sourceIndex, 1);
      await this.saveState();
      this.sendState();
      
      vscode.window.showInformationMessage(`🗑️ Removed ${source.name} from documentation sources`);
    }
  }

  private async toggleSource(id: string) {
    const source = this.state.sources.find(s => s.id === id);
    if (source) {
      source.enabled = !source.enabled;
      await this.saveState();
      this.sendState();
      
      const enabledCount = this.state.sources.filter(s => s.enabled && s.status === 'success').length;
      vscode.window.showInformationMessage(
        `📚 ${source.enabled ? 'Enabled' : 'Disabled'} ${source.name}. ${enabledCount} sources active for @docpilot context.`
      );
    }
  }

  private async startScraping(id: string) {
    const source = this.state.sources.find(s => s.id === id);
    if (!source || source.status === 'scraping') {
      return;
    }

    const jobId = `docpilot-${Date.now()}`;
    const config: IngestionJobConfig = {
      jobId,
      seedUrls: [source.url],
      maxDepth: source.config.maxDepth,
      maxPages: source.config.maxPages,
      followExternal: source.config.followExternal
    };

    try {
      source.status = 'scraping';
      source.jobId = jobId;
      await this.saveState();
      this.sendState();

      await this._workerManager.startIngestion(config);
      vscode.window.showInformationMessage(`🚀 Started scraping ${source.name}`);
    } catch (error) {
      source.status = 'error';
      source.error = error instanceof Error ? error.message : 'Unknown error';
      await this.saveState();
      this.sendState();
      vscode.window.showErrorMessage(`Failed to start scraping: ${source.error}`);
    }
  }

  private async updateSettings(settings: { isAugmentationEnabled?: boolean; maxContextChunks?: number }) {
    if (typeof settings.isAugmentationEnabled === 'boolean') {
      this.state.isAugmentationEnabled = settings.isAugmentationEnabled;
      await vscode.workspace.getConfiguration('docpilot').update('contextAugmentation.enabled', settings.isAugmentationEnabled, vscode.ConfigurationTarget.Workspace);
    }
    
    if (typeof settings.maxContextChunks === 'number') {
      this.state.maxContextChunks = Math.max(1, Math.min(10, settings.maxContextChunks));
      await vscode.workspace.getConfiguration('docpilot').update('contextAugmentation.maxChunks', this.state.maxContextChunks, vscode.ConfigurationTarget.Workspace);
    }
    
    await this.saveState();
    this.sendState();
  }

  private sendState() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'state', data: this.state });
    }
  }

  private async loadState() {
    try {
      const workspaceState = this._context.workspaceState;
      const sources = workspaceState.get<DocumentSource[]>('docpilot.sources', []);
      
      // Load configuration
      const config = vscode.workspace.getConfiguration('docpilot');
      const isAugmentationEnabled = config.get<boolean>('contextAugmentation.enabled', true);
      const maxContextChunks = config.get<number>('contextAugmentation.maxChunks', 3);
      
      this.state = {
        sources,
        isAugmentationEnabled,
        maxContextChunks
      };
    } catch (error) {
      console.error('Failed to load state:', error);
    }
  }

  private async saveState() {
    try {
      await this._context.workspaceState.update('docpilot.sources', this.state.sources);
    } catch (error) {
      console.error('Failed to save state:', error);
    }
  }

  private handleWorkerMessage(event: any) {
    if (event.type === 'job-status') {
      const jobId = event.payload.jobId;
      const source = this.state.sources.find(s => s.jobId === jobId);
      
      if (source) {
        switch (event.payload.status) {
          case 'completed':
            source.status = 'success';
            source.stats = {
              pagesScraped: event.payload.processedPages || 0,
              chunksCreated: event.payload.chunksCreated || 0
            };
            source.lastScraped = new Date();
            break;
          case 'error':
          case 'cancelled':
            source.status = 'error';
            source.error = event.payload.error || 'Job cancelled';
            break;
        }
        
        this.saveState();
        this.sendState();
      }
    }

    if (event.type === 'page-result') {
      const jobId = event.payload.jobId;
      const source = this.state.sources.find(s => s.jobId === jobId);
      
      if (source) {
        // Update running stats
        source.stats = {
          pagesScraped: (source.stats?.pagesScraped || 0) + 1,
          chunksCreated: (source.stats?.chunksCreated || 0) + (event.payload.chunks?.length || 0)
        };
        
        this.sendState();
      }
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DocPilot</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            margin: 0;
            padding: 16px;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 20px;
            border-bottom: 1px solid var(--vscode-sideBar-border);
            padding-bottom: 12px;
        }
        .header h2 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
        }
        .section {
            margin-bottom: 24px;
        }
        .section h3 {
            margin: 0 0 12px 0;
            font-size: 14px;
            font-weight: 600;
            color: var(--vscode-titleBar-activeForeground);
        }
        .add-source-form {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 16px;
        }
        .form-group {
            margin-bottom: 12px;
        }
        .form-group:last-child {
            margin-bottom: 0;
        }
        .form-group label {
            display: block;
            margin-bottom: 4px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .form-group input, .form-group select {
            width: 100%;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            color: var(--vscode-input-foreground);
            font-size: 12px;
            box-sizing: border-box;
        }
        .form-group input:focus, .form-group select:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }
        .form-row {
            display: flex;
            gap: 8px;
        }
        .form-row .form-group {
            flex: 1;
        }
        .button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-family: inherit;
            width: 100%;
        }
        .button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .button.danger {
            background-color: var(--vscode-errorForeground);
            color: var(--vscode-editor-background);
        }
        .button.small {
            padding: 4px 8px;
            font-size: 11px;
        }
        .source-item {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 12px;
        }
        .source-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .source-name {
            font-weight: 600;
            font-size: 13px;
        }
        .source-url {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            word-break: break-all;
        }
        .source-stats {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
        }
        .source-actions {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }
        .status-badge {
            padding: 2px 6px;
            border-radius: 2px;
            font-size: 10px;
            font-weight: 500;
            text-transform: uppercase;
        }
        .status-idle { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
        .status-scraping { background: var(--vscode-progressBar-background); color: var(--vscode-foreground); }
        .status-success { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
        .status-error { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
        .empty-state {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .settings {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 12px;
        }
        .toggle {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        .toggle label {
            font-size: 12px;
        }
        .toggle input[type="checkbox"] {
            margin: 0;
        }
        .custom-pages-input {
            margin-top: 8px;
            display: none;
        }
        .custom-pages-input.visible {
            display: block;
        }
    </style>
</head>
<body>
    <div class="header">
        <span>🚀</span>
        <h2>DocPilot</h2>
    </div>

    <div class="section">
      <h3>Latest Doc Suggestions</h3>
      <div id="docSuggestions">
        <div class="empty-state">No suggestions yet. Hover over code to see relevant docs here.</div>
      </div>
    </div>

    <div class="section">
      <h3>Add Documentation Source</h3>
      <div class="add-source-form">
            <div class="form-group">
                <label>URL</label>
                <input type="url" id="sourceUrl" placeholder="https://docs.example.com" />
            </div>
            <div class="form-group">
                <label>Name (optional)</label>
                <input type="text" id="sourceName" placeholder="Auto-detected from URL" />
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Max Depth</label>
                    <select id="maxDepth">
                        <option value="1">1 Level</option>
                        <option value="2" selected>2 Levels</option>
                        <option value="3">3 Levels</option>
                        <option value="4">4 Levels</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Max Pages</label>
                    <select id="maxPages" onchange="toggleCustomPages()">
                        <option value="10">10 Pages</option>
                        <option value="25" selected>25 Pages</option>
                        <option value="50">50 Pages</option>
                        <option value="100">100 Pages</option>
                        <option value="custom">Custom...</option>
                    </select>
                    <div class="custom-pages-input" id="customPagesInput">
                        <label>Custom Page Count</label>
                        <input type="number" id="customPages" placeholder="Enter page count" min="1" max="1000" />
                    </div>
                </div>
            </div>
            <button class="button" onclick="addSource()">Add Source</button>
        </div>
    </div>

    <div class="section">
        <h3>Documentation Sources</h3>
        <div id="sourcesList">
            <div class="empty-state">
                No documentation sources added yet.<br>
                Add a source above to get started.
            </div>
        </div>
    </div>

    <div class="section">
        <h3>Settings</h3>
        <div class="settings">
            <div class="toggle">
                <label>Enable Context Augmentation</label>
                <input type="checkbox" id="augmentationEnabled" onchange="updateSettings()" />
            </div>
            <div class="form-group">
                <label>Max Context Chunks</label>
                <select id="maxContextChunks" onchange="updateSettings()">
                    <option value="1">1 Chunk</option>
                    <option value="2">2 Chunks</option>
                    <option value="3" selected>3 Chunks</option>
                    <option value="5">5 Chunks</option>
                    <option value="10">10 Chunks</option>
                </select>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentState = null;

        // Request initial state
        vscode.postMessage({ type: 'getState' });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'state') {
                currentState = message.data;
                updateUI();
            }
        });

        function updateUI() {
          if (!currentState) return;

          // Update settings
          document.getElementById('augmentationEnabled').checked = currentState.isAugmentationEnabled;
          document.getElementById('maxContextChunks').value = currentState.maxContextChunks;

          // Update sources list
          const sourcesList = document.getElementById('sourcesList');
          if (currentState.sources.length === 0) {
            sourcesList.innerHTML = '<div class="empty-state">No documentation sources added yet.<br>Add a source above to get started.</div>';
          } else {
            sourcesList.innerHTML = currentState.sources.map(source => `
              <div class="source-item">
                <div class="source-header">
                  <div class="source-name">${source.name}</div>
                  <span class="status-badge status-${source.status}">${source.status}</span>
                </div>
                <div class="source-url">${source.url}</div>
                ${source.stats ? `<div class="source-stats">📄 ${source.stats.pagesScraped} pages • 📦 ${source.stats.chunksCreated} chunks</div>` : ''}
                <div class="source-actions">
                  <button class="button small ${source.enabled ? 'secondary' : ''}" onclick="toggleSource('${source.id}')">
                    ${source.enabled ? 'Disable' : 'Enable'}
                  </button>
                  ${source.status !== 'scraping' ? `<button class="button small" onclick="startScraping('${source.id}')">Scrape</button>` : ''}
                  <button class="button small danger" onclick="removeSource('${source.id}')">Remove</button>
                </div>
              </div>
            `).join('');
          }

          // Update doc suggestions (placeholder, to be wired from extension)
          const docSuggestions = document.getElementById('docSuggestions');
          if (window.latestDocSuggestions && window.latestDocSuggestions.length > 0) {
            docSuggestions.innerHTML = window.latestDocSuggestions.map((item, idx) => `
              <div class="source-item">
                <div class="source-header">
                  <div class="source-name">${item.heading || 'Doc Suggestion'}</div>
                </div>
                <div class="source-url">${item.url || ''}</div>
                <div style="margin: 8px 0;">${item.text}</div>
                <div class="source-actions">
                  <button class="button small" onclick="pinSuggestion(${idx})">Pin</button>
                  <button class="button small" onclick="rateSuggestion(${idx}, 1)">👍</button>
                  <button class="button small" onclick="rateSuggestion(${idx}, -1)">👎</button>
                </div>
              </div>
            `).join('');
          } else {
            docSuggestions.innerHTML = '<div class="empty-state">No suggestions yet. Hover over code to see relevant docs here.</div>';
          }
        }

        window.latestDocSuggestions = [];
        function setDocSuggestions(suggestions) {
          window.latestDocSuggestions = suggestions;
          updateUI();
        }
        function pinSuggestion(idx) {
          // Placeholder: send pin event to extension
        }
        function rateSuggestion(idx, value) {
          // Placeholder: send rating event to extension
        }

        function toggleCustomPages() {
            const select = document.getElementById('maxPages');
            const customInput = document.getElementById('customPagesInput');
            
            if (select.value === 'custom') {
                customInput.classList.add('visible');
            } else {
                customInput.classList.remove('visible');
            }
        }

        function addSource() {
            const url = document.getElementById('sourceUrl').value;
            const name = document.getElementById('sourceName').value;
            const maxDepth = parseInt(document.getElementById('maxDepth').value);
            const maxPagesSelect = document.getElementById('maxPages').value;
            
            let maxPages;
            if (maxPagesSelect === 'custom') {
                const customPages = parseInt(document.getElementById('customPages').value);
                if (!customPages || customPages < 1 || customPages > 1000) {
                    alert('Please enter a valid page count between 1 and 1000');
                    return;
                }
                maxPages = customPages;
            } else {
                maxPages = parseInt(maxPagesSelect);
            }

            if (!url) {
                return;
            }

            vscode.postMessage({
                type: 'addSource',
                data: {
                    url,
                    name: name || undefined,
                    config: {
                        maxDepth,
                        maxPages,
                        followExternal: false
                    }
                }
            });

            // Clear form
            document.getElementById('sourceUrl').value = '';
            document.getElementById('sourceName').value = '';
            document.getElementById('maxPages').value = '25';
            document.getElementById('customPages').value = '';
            document.getElementById('customPagesInput').classList.remove('visible');
        }

        function removeSource(id) {
            vscode.postMessage({
                type: 'removeSource',
                data: { id }
            });
        }

        function toggleSource(id) {
            vscode.postMessage({
                type: 'toggleSource',
                data: { id }
            });
        }

        function startScraping(id) {
            vscode.postMessage({
                type: 'startScraping',
                data: { id }
            });
        }

        function updateSettings() {
            const isAugmentationEnabled = document.getElementById('augmentationEnabled').checked;
            const maxContextChunks = parseInt(document.getElementById('maxContextChunks').value);

            vscode.postMessage({
                type: 'updateSettings',
                data: {
                    isAugmentationEnabled,
                    maxContextChunks
                }
            });
        }
    </script>
</body>
</html>`;
  }
}