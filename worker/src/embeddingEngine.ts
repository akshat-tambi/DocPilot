import { pipeline, FeatureExtractionPipeline } from '@xenova/transformers';

export interface EmbeddingResult {
  vector: Float32Array;
  dimensions: number;
}

export class EmbeddingEngine {
  private model: FeatureExtractionPipeline | null = null;
  private readonly modelId = 'Xenova/all-MiniLM-L6-v2';

  public async initialize(): Promise<void> {
    if (this.model) {
      return;
    }

    try {
      this.model = await pipeline('feature-extraction', this.modelId, {
        quantized: true,
        cache_dir: process.env.TRANSFORMERS_CACHE || './.cache'
      });
    } catch (error) {
      throw new Error(`Failed to load embedding model: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async embed(text: string): Promise<EmbeddingResult> {
    if (!this.model) {
      throw new Error('Embedding model not initialized. Call initialize() first.');
    }

    if (!text.trim()) {
      throw new Error('Cannot embed empty text');
    }

    try {
      const result = await this.model(text, {
        pooling: 'mean',
        normalize: true
      });

      const vector = new Float32Array(result.data as ArrayLike<number>);
      
      return {
        vector,
        dimensions: vector.length
      };
    } catch (error) {
      throw new Error(`Embedding generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.model) {
      throw new Error('Embedding model not initialized. Call initialize() first.');
    }

    const validTexts = texts.filter(text => text.trim());
    if (validTexts.length === 0) {
      return [];
    }

    try {
      const results = await Promise.all(validTexts.map(text => this.embed(text)));
      return results;
    } catch (error) {
      throw new Error(`Batch embedding failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public dispose(): void {
    this.model = null;
  }
}