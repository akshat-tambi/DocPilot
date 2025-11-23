import type { TextChunk, IntelligentChunkResult, CodeBlock } from '@docpilot/shared';
import { EmbeddingEngine, type EmbeddingResult } from './embeddingEngine';
import { VectorStore, type SearchResult } from './vectorStore';
import { LLMPipeline, type LLMConfig } from './llmPipelines';

interface CacheEntry {
  result: IntelligentRetrievalResult;
  timestamp: number;
  hits: number;
}

export interface RetrievalQuery {
  text: string;
  limit?: number;
  jobIds?: string[];
  threshold?: number;
}

export interface RetrievalResult {
  chunks: Array<{
    chunk: TextChunk;
    score: number;
    url: string;
    headings: string[];
  }>;
  totalFound: number;
  queryTime: number;
}

export interface IntelligentRetrievalResult {
  chunks: IntelligentChunkResult[];
  totalFound: number;
  queryTime: number;
  llmProcessingTime: number;
  fromCache?: boolean;
}

export class RetrievalEngine {
  private embeddingEngine: EmbeddingEngine;
  private vectorStore: VectorStore;
  private llmPipeline: LLMPipeline;
  private initialized = false;
  private cache: Map<string, CacheEntry> = new Map();
  private readonly cacheMaxSize = 100;
  private readonly cacheTTL = 1000 * 60 * 30; // 30 minutes

  constructor(storagePath?: string, llmConfig?: LLMConfig) {
    this.embeddingEngine = new EmbeddingEngine();
    this.vectorStore = new VectorStore();
    this.llmPipeline = new LLMPipeline(llmConfig);
  }

  public async initialize(storagePath?: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await Promise.all([
        this.embeddingEngine.initialize(),
        this.vectorStore.initialize(storagePath),
        this.llmPipeline.initialize()
      ]);
      
      this.initialized = true;
    } catch (error) {
      throw new Error(`Failed to initialize retrieval engine: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private generateCacheKey(query: string, limit: number, jobIds?: string[]): string {
    const jobIdStr = jobIds?.sort().join(',') || 'all';
    return `${query.toLowerCase().trim()}:${limit}:${jobIdStr}`;
  }

  private getCached(key: string): IntelligentRetrievalResult | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    // Check if cache entry is expired
    if (Date.now() - entry.timestamp > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }

    // Update hit count
    entry.hits++;
    console.log(`[RetrievalEngine] Cache hit for query "${key.split(':')[0]}" (${entry.hits} hits)`);
    return entry.result;
  }

  private setCache(key: string, result: IntelligentRetrievalResult): void {
    // Implement LRU eviction if cache is full
    if (this.cache.size >= this.cacheMaxSize) {
      // Find least recently used entry (oldest timestamp with fewest hits)
      let lruKey: string | null = null;
      let lruScore = Infinity;

      for (const [k, entry] of this.cache.entries()) {
        const score = entry.timestamp / 1000 + entry.hits * 60000; // Prioritize recent and frequently used
        if (score < lruScore) {
          lruScore = score;
          lruKey = k;
        }
      }

      if (lruKey) {
        console.log(`[RetrievalEngine] Evicting cache entry: ${lruKey.split(':')[0]}`);
        this.cache.delete(lruKey);
      }
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      hits: 0
    });
    console.log(`[RetrievalEngine] Cached result for query "${key.split(':')[0]}" (cache size: ${this.cache.size})`);
  }

  public clearCache(): void {
    const size = this.cache.size;
    this.cache.clear();
    console.log(`[RetrievalEngine] Cleared ${size} cache entries`);
  }

  public getCacheStats(): { size: number; maxSize: number; entries: Array<{ query: string; hits: number; age: number }> } {
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      query: key.split(':')[0],
      hits: entry.hits,
      age: Math.round((Date.now() - entry.timestamp) / 1000)
    }));

    return {
      size: this.cache.size,
      maxSize: this.cacheMaxSize,
      entries: entries.sort((a, b) => b.hits - a.hits)
    };
  }

  public async indexChunks(jobId: string, url: string, chunks: TextChunk[]): Promise<void> {
    if (!this.initialized) {
      throw new Error('Retrieval engine not initialized');
    }

    if (chunks.length === 0) {
      return;
    }

    try {
      // Extract text for embedding
      const texts = chunks.map(chunk => chunk.text);
      
      // Generate embeddings for all chunks
      const embeddings = await this.embeddingEngine.embedBatch(texts);
      const vectors = embeddings.map(emb => emb.vector);

      // Store in vector database
      await this.vectorStore.addChunks(jobId, url, chunks, vectors);
    } catch (error) {
      throw new Error(`Failed to index chunks: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    if (!this.initialized) {
      throw new Error('Retrieval engine not initialized');
    }

    const startTime = Date.now();

    try {
      // Generate query embedding
      const queryEmbedding = await this.embeddingEngine.embed(query.text);
      
      // Search vector store
      const searchResults = await this.vectorStore.search(
        queryEmbedding.vector,
        query.limit || 10,
        query.jobIds
      );

      // Filter by threshold if specified
      const threshold = query.threshold || 0.1;
      const filteredResults = searchResults.filter(result => result.score >= threshold);

      // Convert to retrieval format
      const chunks = filteredResults.map(result => ({
        chunk: {
          id: result.document.metadata.chunkId,
          jobId: result.document.jobId,
          url: result.document.url,
          order: result.document.chunkIndex,
          headingPath: result.document.headings,
          text: result.document.text,
          wordCount: result.document.metadata.wordCount,
          charCount: result.document.metadata.charCount,
          createdAt: result.document.metadata.createdAt
        } as TextChunk,
        score: result.score,
        url: result.document.url,
        headings: result.document.headings
      }));

      return {
        chunks,
        totalFound: filteredResults.length,
        queryTime: Date.now() - startTime
      };
    } catch (error) {
      throw new Error(`Retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Intelligent retrieval with LLM-powered answer extraction, summarization, and reranking.
   * This is the recommended method for end-user queries.
   * Results are cached to avoid reprocessing the same queries.
   */
  public async intelligentRetrieve(query: RetrievalQuery): Promise<IntelligentRetrievalResult> {
    if (!this.initialized) {
      throw new Error('Retrieval engine not initialized');
    }

    // Check cache first
    const cacheKey = this.generateCacheKey(query.text, query.limit || 5, query.jobIds);
    const cachedResult = this.getCached(cacheKey);
    if (cachedResult) {
      // Mark as from cache and return
      return { ...cachedResult, fromCache: true };
    }

    const startTime = Date.now();
    const llmStartTime = Date.now();

    try {
      // Stage 1: Semantic search - get more candidates for reranking
      const initialLimit = Math.max((query.limit || 5) * 4, 20);
      const basicResults = await this.retrieve({
        ...query,
        limit: initialLimit
      });

      if (basicResults.chunks.length === 0) {
        return {
          chunks: [],
          totalFound: 0,
          queryTime: Date.now() - startTime,
          llmProcessingTime: 0
        };
      }

      // Stage 2: Rerank with cross-encoder for better relevance
      const textsToRerank = basicResults.chunks.map(c => c.chunk.text);
      const rerankResults = await this.llmPipeline.rerank(query.text, textsToRerank);

      // Take top results after reranking
      const topReranked = rerankResults
        .slice(0, query.limit || 5)
        .map(r => ({
          ...basicResults.chunks[r.index],
          rerankScore: r.score
        }));

      // Stage 3: Extract answers and summaries in parallel
      const intelligentChunks = await Promise.all(
        topReranked.map(async (result) => {
          const chunkText = result.chunk.text;
          
          // Extract precise answer
          const answerResult = await this.llmPipeline.extractAnswer(query.text, chunkText);
          
          // Generate summary
          const summaryResult = await this.llmPipeline.summarize(chunkText, 3);
          
          // Extract code blocks from text
          const codeBlocks = this.extractCodeBlocks(chunkText);

          const intelligentChunk: IntelligentChunkResult = {
            chunkId: result.chunk.id,
            url: result.url,
            headings: result.headings,
            text: chunkText,
            score: result.score,
            rerankScore: result.rerankScore,
            answer: answerResult?.answer,
            answerConfidence: answerResult?.confidence,
            summary: summaryResult?.summary,
            codeExamples: codeBlocks
          };

          return intelligentChunk;
        })
      );

      // Filter out results with very low answer confidence (unless no good answers exist)
      const hasGoodAnswer = intelligentChunks.some(c => (c.answerConfidence || 0) > 0.3);
      const filteredChunks = hasGoodAnswer
        ? intelligentChunks.filter(c => !c.answerConfidence || c.answerConfidence > 0.1)
        : intelligentChunks;

      const result: IntelligentRetrievalResult = {
        chunks: filteredChunks,
        totalFound: filteredChunks.length,
        queryTime: Date.now() - startTime,
        llmProcessingTime: Date.now() - llmStartTime,
        fromCache: false
      };

      // Cache the result
      this.setCache(cacheKey, result);

      return result;
    } catch (error) {
      console.error('[RetrievalEngine] Intelligent retrieval failed, falling back to basic:', error);
      
      // Fallback to basic retrieval if LLM fails
      const basicResult = await this.retrieve(query);
      return {
        chunks: basicResult.chunks.map(c => ({
          chunkId: c.chunk.id,
          url: c.url,
          headings: c.headings,
          text: c.chunk.text,
          score: c.score
        })),
        totalFound: basicResult.totalFound,
        queryTime: Date.now() - startTime,
        llmProcessingTime: Date.now() - llmStartTime
      };
    }
  }

  /**
   * Extract code blocks from text using simple pattern matching.
   * Will be enhanced when we improve HTML parsing.
   */
  private extractCodeBlocks(text: string): CodeBlock[] {
    const codeBlocks: CodeBlock[] = [];
    
    // Match markdown-style code blocks: ```language\ncode\n```
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;
    
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const language = match[1] || 'text';
      const code = match[2].trim();
      
      // Get surrounding context (100 chars before and after)
      const startIdx = Math.max(0, match.index - 100);
      const endIdx = Math.min(text.length, match.index + match[0].length + 100);
      const context = text.slice(startIdx, match.index) + text.slice(match.index + match[0].length, endIdx);
      
      if (code) {
        codeBlocks.push({
          language,
          code,
          context: context.trim()
        });
      }
    }
    
    // Also match inline code: `code`
    const inlineCodeRegex = /`([^`]+)`/g;
    const inlineCodes: string[] = [];
    
    while ((match = inlineCodeRegex.exec(text)) !== null) {
      const code = match[1].trim();
      if (code && code.length > 5 && code.length < 100) {
        inlineCodes.push(code);
      }
    }
    
    // If we have many inline codes, group them as a code block
    if (inlineCodes.length > 3) {
      codeBlocks.push({
        language: 'text',
        code: inlineCodes.join('\n'),
        context: 'Inline code examples from documentation'
      });
    }
    
    return codeBlocks;
  }

  public async deleteJob(jobId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('Retrieval engine not initialized');
    }

    try {
      await this.vectorStore.clearJob(jobId);
    } catch (error) {
      throw new Error(`Failed to delete job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getStats(): Promise<{ totalChunks: number; metadata: any }> {
    if (!this.initialized) {
      throw new Error('Retrieval engine not initialized');
    }

    try {
      const info = await this.vectorStore.getCollectionInfo();
      return {
        totalChunks: info.count,
        metadata: info.metadata
      };
    } catch (error) {
      throw new Error(`Failed to get stats: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public dispose(): void {
    this.embeddingEngine.dispose();
    this.vectorStore.dispose();
    this.llmPipeline.dispose();
    this.initialized = false;
  }
}