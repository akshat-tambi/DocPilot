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

export class DocPilotPanel {
  public static currentPanel: DocPilotPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly workerManager: WorkerManager;
  private readonly extensionContext: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  
  private state: UIState = {
    sources: [],
    isAugmentationEnabled: true,
    maxContextChunks: 3
  };

  public static createOrShow(extensionUri: vscode.Uri, workerManager: WorkerManager, extensionContext: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : undefined;

    if (DocPilotPanel.currentPanel) {
      DocPilotPanel.currentPanel.panel.reveal(column);
      return DocPilotPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'docpilot',
      'DocPilot',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          vscode.Uri.joinPath(extensionUri, 'out', 'compiled')
        ]
      }
    );

    DocPilotPanel.currentPanel = new DocPilotPanel(panel, extensionUri, workerManager, extensionContext);
    return DocPilotPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, workerManager: WorkerManager, extensionContext: vscode.ExtensionContext) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.workerManager = workerManager;
    this.extensionContext = extensionContext;

    this.loadState().then(() => {
      this.update();
    });
    
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        await this.handleMessage(message);
      },
      null,
      this.disposables
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

    // Use actual form values from UI
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
      
      // Cancel ongoing scraping if any
      if (source.jobId && source.status === 'scraping') {
        try {
          await this.workerManager.cancel(source.jobId);
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
      
      // Notify user about context changes
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

      await this.workerManager.startIngestion(config);
      
      // Listen for worker messages to track completion
      let totalChunks = 0;
      const messageHandler = (event: any) => {
        console.log('DocPilot worker event:', event.type, event.payload);
        
        if (event.type === 'job-status' && event.payload?.jobId === jobId) {
          if (event.payload.status === 'completed') {
            source.status = 'success';
            source.lastScraped = new Date();
            source.stats = {
              pagesScraped: event.payload.processedPages || 0,
              chunksCreated: totalChunks
            };
            delete source.jobId;
            this.saveState().then(() => this.sendState());
            this.workerManager.off('message', messageHandler);
          } else if (event.payload.status === 'failed') {
            source.status = 'error';
            source.error = event.payload.error || 'Scraping failed';
            delete source.jobId;
            this.saveState().then(() => this.sendState());
            this.workerManager.off('message', messageHandler);
          } else if (event.payload.status === 'cancelled') {
            // Handle truly cancelled jobs (user cancellation, errors, etc.)
            source.status = 'error';
            source.error = event.payload.error || 'Scraping cancelled';
            delete source.jobId;
            this.saveState().then(() => this.sendState());
            this.workerManager.off('message', messageHandler);
          } else if (event.payload.status === 'running') {
            // Update temporary stats during scraping - make sure to initialize if not present
            if (!source.stats) {
              source.stats = { pagesScraped: 0, chunksCreated: 0 };
            }
            source.stats.pagesScraped = event.payload.processedPages || 0;
            source.stats.chunksCreated = totalChunks;
            this.sendState();
          }
        } else if (event.type === 'page-result' && event.payload?.jobId === jobId) {
          // Accumulate chunks from completed pages
          totalChunks += event.payload.chunks?.length || 0;
          // Update chunks count only (pages count comes from job-status)
          if (source.stats) {
            source.stats.chunksCreated = totalChunks;
            this.sendState();
          }
        } else if (event.type === 'page-progress' && event.payload?.jobId === jobId) {
          // Update progress during scraping
          this.sendState();
        }
      };
      
      this.workerManager.on('message', messageHandler);
      
      // Add timeout fallback
      setTimeout(() => {
        if (source.status === 'scraping') {
          source.status = 'error';
          source.error = 'Scraping timeout';
          delete source.jobId;
          this.saveState().then(() => this.sendState());
          this.workerManager.off('message', messageHandler);
        }
      }, 120000); // 2 minute timeout

    } catch (error) {
      source.status = 'error';
      source.error = error instanceof Error ? error.message : String(error);
      delete source.jobId;
      await this.saveState();
      this.sendState();
      vscode.window.showErrorMessage(`Failed to start scraping: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async updateSettings(settings: Partial<UIState>) {
    Object.assign(this.state, settings);
    await this.saveState();
    this.sendState();
  }

  private sendState() {
    this.panel.webview.postMessage({
      type: 'stateUpdate',
      data: this.state
    });
  }

  private async saveState() {
    // Save to workspace state - check for .vscode folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      // Find workspace with .vscode folder or use first one
      let targetWorkspace = workspaceFolders[0];
      for (const folder of workspaceFolders) {
        try {
          const vscodeFolderUri = vscode.Uri.joinPath(folder.uri, '.vscode');
          await vscode.workspace.fs.stat(vscodeFolderUri);
          targetWorkspace = folder;
          break;
        } catch {
          // No .vscode folder in this workspace
        }
      }
      
      const workspaceStateKey = `docpilot.ui.${targetWorkspace.uri.fsPath}`;
      await this.extensionContext.workspaceState.update(workspaceStateKey, this.state);
    }
  }

  private async loadState() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      // Find workspace with .vscode folder or use first one
      let targetWorkspace = workspaceFolders[0];
      for (const folder of workspaceFolders) {
        try {
          const vscodeFolderUri = vscode.Uri.joinPath(folder.uri, '.vscode');
          await vscode.workspace.fs.stat(vscodeFolderUri);
          targetWorkspace = folder;
          break;
        } catch {
          // No .vscode folder in this workspace
        }
      }
      
      const workspaceStateKey = `docpilot.ui.${targetWorkspace.uri.fsPath}`;
      const saved = this.extensionContext.workspaceState.get<UIState>(workspaceStateKey);
      if (saved) {
        this.state = { ...this.state, ...saved };
      }
    }
  }

  public getEnabledSources(): DocumentSource[] {
    return this.state.sources.filter(s => s.enabled && s.status === 'success');
  }

  public getAugmentationSettings() {
    return {
      enabled: this.state.isAugmentationEnabled,
      maxChunks: this.state.maxContextChunks
    };
  }

  private update() {
    this.panel.webview.html = this.getWebviewContent();
  }

  private getWebviewContent(): string {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DocPilot</title>
        <style>
            body {
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                line-height: var(--vscode-font-weight);
                color: var(--vscode-foreground);
                background-color: var(--vscode-editor-background);
                padding: 20px;
            }
            
            .header {
                border-bottom: 1px solid var(--vscode-panel-border);
                padding-bottom: 15px;
                margin-bottom: 20px;
            }
            
            .section {
                margin-bottom: 30px;
            }
            
            .section h3 {
                margin-bottom: 15px;
                color: var(--vscode-titleBar-activeForeground);
            }
            
            .source-item {
                border: 1px solid var(--vscode-panel-border);
                border-radius: 4px;
                padding: 15px;
                margin-bottom: 10px;
                background: var(--vscode-input-background);
            }
            
            .source-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            }
            
            .source-name {
                font-weight: bold;
            }
            
            .source-url {
                color: var(--vscode-descriptionForeground);
                font-size: 0.9em;
                word-break: break-all;
            }
            
            .source-status {
                display: inline-block;
                padding: 2px 8px;
                border-radius: 12px;
                font-size: 0.8em;
                font-weight: bold;
            }
            
            .status-idle { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
            .status-scraping { background: var(--vscode-progressBar-background); color: var(--vscode-foreground); }
            .status-success { background: var(--vscode-testing-iconPassed); color: white; }
            .status-error { background: var(--vscode-testing-iconFailed); color: white; }
            
            .source-actions {
                display: flex;
                gap: 10px;
                margin-top: 10px;
            }
            
            button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 6px 12px;
                border-radius: 2px;
                cursor: pointer;
                font-size: 0.9em;
            }
            
            button:hover {
                background: var(--vscode-button-hoverBackground);
            }
            
            button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            
            .secondary-button {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
            }
            
            .secondary-button:hover {
                background: var(--vscode-button-secondaryHoverBackground);
            }
            
            .add-source-form {
                background: var(--vscode-input-background);
                border: 1px solid var(--vscode-input-border);
                padding: 15px;
                border-radius: 4px;
                margin-bottom: 20px;
            }
            
            .form-group {
                margin-bottom: 15px;
            }
            
            label {
                display: block;
                margin-bottom: 5px;
                font-weight: bold;
            }
            
            input, select {
                width: 100%;
                padding: 6px 8px;
                background: var(--vscode-input-background);
                border: 1px solid var(--vscode-input-border);
                color: var(--vscode-input-foreground);
                border-radius: 2px;
            }
            
            .form-row {
                display: flex;
                gap: 15px;
            }
            
            .form-row .form-group {
                flex: 1;
            }
            
            .settings {
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-panel-border);
                padding: 15px;
                border-radius: 4px;
            }
            
            .checkbox-group {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 10px;
            }
            
            input[type="checkbox"] {
                width: auto;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h2>🚀 DocPilot</h2>
            <p>Manage documentation sources and augment your Copilot conversations</p>
        </div>
        
        <div class="section">
            <h3>Settings</h3>
            <div class="settings">
                <div class="checkbox-group">
                    <input type="checkbox" id="enableAugmentation" checked>
                    <label for="enableAugmentation">Enable context augmentation</label>
                </div>
                
                <div class="form-group">
                    <label for="maxChunks">Max context chunks:</label>
                    <input type="number" id="maxChunks" value="3" min="1" max="10">
                </div>
            </div>
        </div>
        
        <div class="section">
            <h3>Add Documentation Source</h3>
            <div class="add-source-form">
                <div class="form-group">
                    <label for="sourceName">Name:</label>
                    <input type="text" id="sourceName" placeholder="e.g., React Docs">
                </div>
                
                <div class="form-group">
                    <label for="sourceUrl">URL:</label>
                    <input type="url" id="sourceUrl" placeholder="https://react.dev/docs">
                </div>
                
                <div class="form-row">
                    <div class="form-group">
                        <label for="maxDepth">Max Depth:</label>
                        <input type="number" id="maxDepth" value="2" min="1" max="10">
                    </div>
                    
                    <div class="form-group">
                        <label for="maxPages">Max Pages:</label>
                        <input type="number" id="maxPages" value="25" min="1" max="1000">
                    </div>
                </div>
                
                <div class="checkbox-group">
                    <input type="checkbox" id="followExternal">
                    <label for="followExternal">Follow external links</label>
                </div>
                
                <button onclick="addSource()">Add Source</button>
            </div>
        </div>
        
        <div class="section">
            <h3>Documentation Sources</h3>
            <div id="sourcesList">
                <!-- Sources will be populated here -->
            </div>
        </div>
        
        <script>
            const vscode = acquireVsCodeApi();
            let currentState = null;
            
            // Request initial state
            vscode.postMessage({ type: 'getState' });
            
            // Listen for state updates
            window.addEventListener('message', event => {
                const message = event.data;
                if (message.type === 'stateUpdate') {
                    currentState = message.data;
                    updateUI();
                }
            });
            
            function updateUI() {
                if (!currentState) return;
                
                // Update settings
                document.getElementById('enableAugmentation').checked = currentState.isAugmentationEnabled;
                document.getElementById('maxChunks').value = currentState.maxContextChunks;
                
                // Update sources list
                const sourcesList = document.getElementById('sourcesList');
                sourcesList.innerHTML = '';
                
                if (currentState.sources.length === 0) {
                    sourcesList.innerHTML = '<p style="color: var(--vscode-descriptionForeground);">No documentation sources added yet.</p>';
                    return;
                }
                
                currentState.sources.forEach(source => {
                    const sourceDiv = document.createElement('div');
                    sourceDiv.className = 'source-item';
                    
                    const lastScraped = source.lastScraped 
                        ? new Date(source.lastScraped).toLocaleDateString()
                        : 'Never';
                    
                    const stats = source.stats 
                        ? \`\${source.stats.pagesScraped} pages, \${source.stats.chunksCreated} chunks\`
                        : '';
                    
                    sourceDiv.innerHTML = \`
                        <div class="source-header">
                            <div>
                                <div class="source-name">\${source.name}</div>
                                <div class="source-url">\${source.url}</div>
                            </div>
                            <span class="source-status status-\${source.status}">\${source.status.toUpperCase()}</span>
                        </div>
                        
                        <div style="font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-bottom: 10px;">
                            Last scraped: \${lastScraped} \${stats ? '• ' + stats : ''}
                        </div>
                        
                        <div class="source-actions">
                            <input type="checkbox" \${source.enabled ? 'checked' : ''} 
                                   onchange="toggleSource('\${source.id}')" 
                                   id="enabled-\${source.id}">
                            <label for="enabled-\${source.id}">Include in context</label>
                            
                            <button onclick="startScraping('\${source.id}')" 
                                    \${source.status === 'scraping' ? 'disabled' : ''}>
                                \${source.status === 'scraping' ? 'Scraping...' : 'Scrape'}
                            </button>
                            
                            <button class="secondary-button" onclick="removeSource('\${source.id}')">
                                Remove
                            </button>
                        </div>
                    \`;
                    
                    sourcesList.appendChild(sourceDiv);
                });
            }
            
            function addSource() {
                const name = document.getElementById('sourceName').value.trim();
                const url = document.getElementById('sourceUrl').value.trim();
                const maxDepth = parseInt(document.getElementById('maxDepth').value);
                const maxPages = parseInt(document.getElementById('maxPages').value);
                const followExternal = document.getElementById('followExternal').checked;
                
                if (!url) {
                    alert('Please enter a URL');
                    return;
                }
                
                vscode.postMessage({
                    type: 'addSource',
                    data: {
                        name,
                        url,
                        config: {
                            maxDepth,
                            maxPages,
                            followExternal
                        }
                    }
                });
                
                // Clear form
                document.getElementById('sourceName').value = '';
                document.getElementById('sourceUrl').value = '';
                document.getElementById('maxDepth').value = '2';
                document.getElementById('maxPages').value = '25';
                document.getElementById('followExternal').checked = false;
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
            
            // Settings change handlers
            document.getElementById('enableAugmentation').addEventListener('change', updateSettings);
            document.getElementById('maxChunks').addEventListener('change', updateSettings);
            
            function updateSettings() {
                vscode.postMessage({
                    type: 'updateSettings',
                    data: {
                        isAugmentationEnabled: document.getElementById('enableAugmentation').checked,
                        maxContextChunks: parseInt(document.getElementById('maxChunks').value)
                    }
                });
            }
        </script>
    </body>
    </html>`;
  }



  public dispose() {
    DocPilotPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const x = this.disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}