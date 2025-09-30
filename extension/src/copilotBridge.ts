import * as vscode from 'vscode';
export interface RetrievalResult {
  chunks: Array<{
    chunk: any;
    score: number;
    url: string;
    headings: string[];
  }>;
  totalFound: number;
  queryTime: number;
}

export interface CopilotContextItem {
  content: string;
  uri: vscode.Uri;
  range?: vscode.Range;
}

export class CopilotBridge {
  private readonly retrievalCallback: (query: string) => Promise<RetrievalResult>;
  private readonly outputChannel: vscode.OutputChannel;

  constructor(
    retrievalCallback: (query: string) => Promise<RetrievalResult>,
    outputChannel: vscode.OutputChannel
  ) {
    this.retrievalCallback = retrievalCallback;
    this.outputChannel = outputChannel;
  }

  public register(context: vscode.ExtensionContext): void {
    // Register chat participant
    const participant = vscode.chat.createChatParticipant('docpilot.assistant', this.handleChatRequest.bind(this));
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png');
    participant.followupProvider = {
      provideFollowups: this.provideFollowups.bind(this)
    };

    context.subscriptions.push(participant);

    // Context provider registration will be added when API is stable

    this.outputChannel.appendLine('[copilot-bridge] Registered chat participant and context provider');
  }

  private async handleChatRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> {
    try {
      stream.progress('Searching documentation...');

      // Retrieve relevant context
      const retrievalResult = await this.retrievalCallback(request.prompt);

      if (retrievalResult.chunks.length === 0) {
        stream.markdown('No relevant documentation found. Let me help you with general coding knowledge instead.');
        return { metadata: { command: 'docpilot.query' } };
      }

      // Format context for the response
      stream.markdown('## 📚 Relevant Documentation\\n\\n');

      retrievalResult.chunks.slice(0, 3).forEach((item, index) => {
        const headingPath = item.headings.length > 0 ? item.headings.join(' > ') : 'Documentation';
        stream.markdown(`### ${index + 1}. [${headingPath}](${item.url})\\n`);
        stream.markdown(`${item.chunk.text.substring(0, 300)}...\\n\\n`);
        stream.markdown(`*Score: ${(item.score * 100).toFixed(1)}% | Words: ${item.chunk.wordCount}*\\n\\n`);
      });

      stream.markdown('---\\n\\n');
      stream.markdown('Now let me help you with your specific question based on this documentation.');

      return {
        metadata: {
          command: 'docpilot.query',
          retrievalTime: retrievalResult.queryTime,
          totalChunks: retrievalResult.totalFound
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stream.markdown(`❌ Error retrieving documentation: ${message}`);
      this.outputChannel.appendLine(`[copilot-bridge] Error: ${message}`);
      
      return { metadata: { command: 'docpilot.query', error: message } };
    }
  }

  // Variable resolver will be implemented when VS Code API is stable

  private provideFollowups(
    result: vscode.ChatResult,
    context: vscode.ChatContext,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.ChatFollowup[]> {
    if (result.metadata?.command === 'docpilot.query') {
      return [
        {
          prompt: 'Show me code examples from the documentation',
          label: '🔍 Code Examples'
        },
        {
          prompt: 'Explain the API usage patterns',
          label: '📖 API Patterns'
        },
        {
          prompt: 'What are the best practices mentioned?',
          label: '✨ Best Practices'
        }
      ];
    }

    return [];
  }

  public async augmentPrompt(originalPrompt: string, maxContextChunks: number = 3): Promise<string> {
    try {
      const retrievalResult = await this.retrievalCallback(originalPrompt);
      
      if (retrievalResult.chunks.length === 0) {
        return originalPrompt;
      }

      const contextChunks = retrievalResult.chunks
        .slice(0, maxContextChunks)
        .map((item, index) => {
          const heading = item.headings.length > 0 ? item.headings.join(' > ') : 'Documentation';
          return `## Context ${index + 1}: ${heading}\\n${item.chunk.text}\\n`;
        })
        .join('\\n');

      return `Based on the following documentation context:\\n\\n${contextChunks}\\n\\n---\\n\\nUser Question: ${originalPrompt}`;
    } catch (error) {
      this.outputChannel.appendLine(`[copilot-bridge] Prompt augmentation error: ${error instanceof Error ? error.message : String(error)}`);
      return originalPrompt;
    }
  }
}