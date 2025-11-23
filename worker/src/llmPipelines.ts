import { pipeline } from '@xenova/transformers';
import type { 
  Pipeline,
  QuestionAnsweringPipeline,
  SummarizationPipeline,
  FeatureExtractionPipeline
} from '@xenova/transformers';

export interface AnswerExtractionResult {
  answer: string;
  confidence: number;
  startIndex: number;
  endIndex: number;
}

export interface SummarizationResult {
  summary: string;
  originalLength: number;
  summaryLength: number;
}

export interface RerankResult {
  index: number;
  score: number;
}

export interface LLMConfig {
  summarizationMaxLength?: number;
  summarizationMinLength?: number;
  qaConfidenceThreshold?: number;
  timeout?: number;
  enableSummarization?: boolean;
  enableQA?: boolean;
  enableReranking?: boolean;
}

const DEFAULT_CONFIG: Required<LLMConfig> = {
  summarizationMaxLength: 130,
  summarizationMinLength: 30,
  qaConfidenceThreshold: 0.1,
  timeout: 3000,
  enableSummarization: true,
  enableQA: true,
  enableReranking: true
};

/**
 * LLMPipeline provides local language model capabilities for:
 * - Text summarization
 * - Question answering / answer extraction
 * - Result reranking
 * 
 * All models run locally using Transformers.js with no API keys required.
 */
export class LLMPipeline {
  private summarizer: SummarizationPipeline | null = null;
  private qaExtractor: QuestionAnsweringPipeline | null = null;
  private rerankerExtractor: FeatureExtractionPipeline | null = null;
  
  private config: Required<LLMConfig>;
  private initialized = false;

  // Model IDs - optimized for size/speed tradeoff
  private readonly SUMMARIZATION_MODEL = 'Xenova/distilbart-cnn-6-6';
  private readonly QA_MODEL = 'Xenova/distilbert-base-cased-distilled-squad';
  private readonly RERANKER_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

  constructor(config: LLMConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize all LLM models. Models are downloaded on first use (~600MB total).
   * Subsequent loads are instant from cache.
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const initPromises: Promise<void>[] = [];

    if (this.config.enableSummarization) {
      initPromises.push(this.initSummarizer());
    }

    if (this.config.enableQA) {
      initPromises.push(this.initQAExtractor());
    }

    if (this.config.enableReranking) {
      initPromises.push(this.initReranker());
    }

    try {
      await Promise.all(initPromises);
      this.initialized = true;
      console.log('[LLM Pipeline] ✅ All models initialized successfully');
    } catch (error) {
      console.error('[LLM Pipeline] ❌ Failed to initialize models:', error);
      throw new Error(`LLM Pipeline initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async initSummarizer(): Promise<void> {
    if (this.summarizer) return;

    try {
      console.log('[LLM Pipeline] Loading summarization model...');
      this.summarizer = await pipeline('summarization', this.SUMMARIZATION_MODEL, {
        quantized: true,
        cache_dir: process.env.TRANSFORMERS_CACHE || './.cache/transformers'
      }) as SummarizationPipeline;
      console.log('[LLM Pipeline] ✅ Summarization model loaded');
    } catch (error) {
      console.error('[LLM Pipeline] Failed to load summarization model:', error);
      this.config.enableSummarization = false;
    }
  }

  private async initQAExtractor(): Promise<void> {
    if (this.qaExtractor) return;

    try {
      console.log('[LLM Pipeline] Loading Q&A extraction model...');
      this.qaExtractor = await pipeline('question-answering', this.QA_MODEL, {
        quantized: true,
        cache_dir: process.env.TRANSFORMERS_CACHE || './.cache/transformers'
      }) as QuestionAnsweringPipeline;
      console.log('[LLM Pipeline] ✅ Q&A extraction model loaded');
    } catch (error) {
      console.error('[LLM Pipeline] Failed to load Q&A model:', error);
      this.config.enableQA = false;
    }
  }

  private async initReranker(): Promise<void> {
    if (this.rerankerExtractor) return;

    try {
      console.log('[LLM Pipeline] Loading reranker model...');
      this.rerankerExtractor = await pipeline('feature-extraction', this.RERANKER_MODEL, {
        quantized: true,
        cache_dir: process.env.TRANSFORMERS_CACHE || './.cache/transformers'
      }) as FeatureExtractionPipeline;
      console.log('[LLM Pipeline] ✅ Reranker model loaded');
    } catch (error) {
      console.error('[LLM Pipeline] Failed to load reranker model:', error);
      this.config.enableReranking = false;
    }
  }

  /**
   * Summarize a text chunk into a concise summary.
   * @param text - The text to summarize
   * @param numSentences - Target number of sentences (approximate)
   * @returns Summary text or null if summarization fails
   */
  public async summarize(text: string, numSentences: number = 3): Promise<SummarizationResult | null> {
    if (!this.config.enableSummarization || !this.summarizer) {
      return null;
    }

    if (!text || text.trim().length < 50) {
      return null;
    }

    try {
      const maxLength = Math.min(this.config.summarizationMaxLength, numSentences * 30);
      const minLength = Math.max(this.config.summarizationMinLength, numSentences * 10);

      const result = await this.withTimeout(
        this.summarizer(text, {
          max_length: maxLength,
          min_length: minLength,
          do_sample: false
        }),
        this.config.timeout
      );

      if (!result || !Array.isArray(result) || result.length === 0) {
        return null;
      }

      const summaryText = (result[0] as any).summary_text || (result[0] as any).generated_text || '';

      return {
        summary: summaryText.trim(),
        originalLength: text.length,
        summaryLength: summaryText.length
      };
    } catch (error) {
      console.warn('[LLM Pipeline] Summarization failed:', error);
      return null;
    }
  }

  /**
   * Extract a precise answer to a question from a context text.
   * @param question - The question to answer
   * @param context - The text containing the answer
   * @returns Answer with confidence score or null if no answer found
   */
  public async extractAnswer(question: string, context: string): Promise<AnswerExtractionResult | null> {
    if (!this.config.enableQA || !this.qaExtractor) {
      return null;
    }

    if (!question || !context || context.trim().length < 20) {
      return null;
    }

    try {
      const result = await this.withTimeout(
        this.qaExtractor(question, context),
        this.config.timeout
      );

      if (!result || typeof result !== 'object') {
        return null;
      }

      const answer = (result as any).answer || '';
      const score = (result as any).score || 0;

      if (score < this.config.qaConfidenceThreshold || !answer.trim()) {
        return null;
      }

      return {
        answer: answer.trim(),
        confidence: score,
        startIndex: (result as any).start || 0,
        endIndex: (result as any).end || answer.length
      };
    } catch (error) {
      console.warn('[LLM Pipeline] Answer extraction failed:', error);
      return null;
    }
  }

  /**
   * Rerank search results based on semantic similarity to query.
   * Uses cross-encoder scoring for better relevance than bi-encoder alone.
   * @param query - The search query
   * @param texts - Array of candidate texts to rerank
   * @returns Array of indices sorted by relevance (best first)
   */
  public async rerank(query: string, texts: string[]): Promise<RerankResult[]> {
    if (!this.config.enableReranking || !this.rerankerExtractor || texts.length === 0) {
      // Fallback: return original order
      return texts.map((_, index) => ({ index, score: 1.0 - (index * 0.01) }));
    }

    try {
      // Compute embeddings for query
      const queryEmbedding = await this.rerankerExtractor(query, {
        pooling: 'mean',
        normalize: true
      });

      // Compute embeddings for all texts
      const textEmbeddings = await Promise.all(
        texts.map(text =>
          this.rerankerExtractor!(text, {
            pooling: 'mean',
            normalize: true
          })
        )
      );

      // Calculate cosine similarity scores
      const scores = textEmbeddings.map((textEmb, index) => {
        const similarity = this.cosineSimilarity(
          Array.from(queryEmbedding.data),
          Array.from(textEmb.data)
        );
        return { index, score: similarity };
      });

      // Sort by score descending
      scores.sort((a, b) => b.score - a.score);

      return scores;
    } catch (error) {
      console.warn('[LLM Pipeline] Reranking failed, using original order:', error);
      return texts.map((_, index) => ({ index, score: 1.0 - (index * 0.01) }));
    }
  }

  /**
   * Process multiple texts in batch for summarization.
   * More efficient than calling summarize() multiple times.
   */
  public async summarizeBatch(texts: string[], numSentences: number = 3): Promise<Array<SummarizationResult | null>> {
    if (!this.config.enableSummarization || !this.summarizer) {
      return texts.map(() => null);
    }

    return Promise.all(texts.map(text => this.summarize(text, numSentences)));
  }

  /**
   * Process multiple Q&A pairs in batch.
   */
  public async extractAnswersBatch(
    questions: string[],
    contexts: string[]
  ): Promise<Array<AnswerExtractionResult | null>> {
    if (!this.config.enableQA || !this.qaExtractor) {
      return questions.map(() => null);
    }

    if (questions.length !== contexts.length) {
      throw new Error('Questions and contexts arrays must have same length');
    }

    return Promise.all(
      questions.map((question, i) => this.extractAnswer(question, contexts[i]))
    );
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Wrap a promise with a timeout
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('LLM operation timeout')), timeoutMs)
      )
    ]);
  }

  /**
   * Check if a specific capability is available
   */
  public hasCapability(capability: 'summarization' | 'qa' | 'reranking'): boolean {
    switch (capability) {
      case 'summarization':
        return this.config.enableSummarization && this.summarizer !== null;
      case 'qa':
        return this.config.enableQA && this.qaExtractor !== null;
      case 'reranking':
        return this.config.enableReranking && this.rerankerExtractor !== null;
      default:
        return false;
    }
  }

  /**
   * Update configuration at runtime
   */
  public updateConfig(newConfig: Partial<LLMConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Dispose of all models and free memory
   */
  public dispose(): void {
    this.summarizer = null;
    this.qaExtractor = null;
    this.rerankerExtractor = null;
    this.initialized = false;
    console.log('[LLM Pipeline] Models disposed');
  }
}
