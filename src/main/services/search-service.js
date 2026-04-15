const { VectorStore } = require('./vector-store');
const { getChunkSearchText } = require('./chunk-search-text');
const natural = require('natural');

class SearchService {
  constructor(vectorStore) {
    this.vectorStore = vectorStore;
    // BM25 parameters
    this.k1 = 1.5; // Term frequency saturation parameter
    this.b = 0.75; // Length normalization parameter
    // Initialize tokenizer from natural library
    // WordTokenizer handles punctuation, acronyms, and various text patterns properly
    this.tokenizer = new natural.WordTokenizer();
  }

  /**
   * Tokenize text into words using natural library's WordTokenizer
   * This properly handles acronyms, punctuation, and various text patterns
   */
  tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    
    // Normalize Unicode whitespace characters first
    let normalized = text.replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');
    
    // Use natural's tokenizer to split into words
    // It handles punctuation, contractions, acronyms, etc. intelligently
    const tokens = this.tokenizer.tokenize(normalized) || [];
    
    // Lowercase and filter out empty strings
    return tokens
      .map(token => token.toLowerCase())
      .filter(word => word.length > 0);
  }

  /**
   * Calculate BM25 score for a document chunk
   */
  calculateBM25Score(queryTerms, chunkContent, avgDocLength, totalDocs, docFreqs) {
    const chunkTerms = this.tokenize(chunkContent);
    const chunkLength = chunkTerms.length;
    const termFreqs = {};
    
    // Count term frequencies in chunk
    chunkTerms.forEach(term => {
      termFreqs[term] = (termFreqs[term] || 0) + 1;
    });

    let score = 0;
    const uniqueQueryTerms = [...new Set(queryTerms)];

    uniqueQueryTerms.forEach(term => {
      const tf = termFreqs[term] || 0;
      const df = docFreqs[term] || 0;
      
      if (df === 0) return; // Term not in any document
      
      // IDF: Lucene-style log(1 + ...) stays non-negative so very common terms
      // (e.g. "service" in most chunks) still rank instead of going negative and
      // filtering out every hit with score > 0.
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      
      // BM25 formula
      const numerator = tf * (this.k1 + 1);
      const denominator = tf + this.k1 * (1 - this.b + this.b * (chunkLength / avgDocLength));
      
      score += idf * (numerator / denominator);
    });

    return score;
  }

  /**
   * Calculate TF-IDF score for a document chunk
   */
  calculateTFIDFScore(queryTerms, chunkContent, totalDocs, docFreqs) {
    const chunkTerms = this.tokenize(chunkContent);
    const termFreqs = {};
    
    // Count term frequencies in chunk
    chunkTerms.forEach(term => {
      termFreqs[term] = (termFreqs[term] || 0) + 1;
    });

    let score = 0;
    const uniqueQueryTerms = [...new Set(queryTerms)];

    uniqueQueryTerms.forEach(term => {
      const tf = termFreqs[term] || 0;
      const df = docFreqs[term] || 0;
      
      if (df === 0 || tf === 0) return;
      
      // Term frequency (normalized)
      const normalizedTF = tf / chunkTerms.length;
      
      // Inverse document frequency
      const idf = Math.log(totalDocs / df);
      
      score += normalizedTF * idf;
    });

    return score;
  }

  /**
   * Calculate cosine similarity for vector search
   */
  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Build document frequency index for all chunks
   * Optimized to process in batches if chunks array is large
   */
  buildDocumentFrequencyIndex(chunks) {
    const docFreqs = {};
    const chunkLengths = [];
    const BATCH_SIZE = 1000; // Process in batches to avoid memory spikes
    
    // Process in batches if we have many chunks
    if (chunks.length > BATCH_SIZE) {
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, Math.min(i + BATCH_SIZE, chunks.length));
        batch.forEach(chunk => {
          const terms = this.tokenize(getChunkSearchText(chunk));
          chunkLengths.push(terms.length);
          
          const uniqueTerms = new Set(terms);
          uniqueTerms.forEach(term => {
            docFreqs[term] = (docFreqs[term] || 0) + 1;
          });
        });
      }
    } else {
      chunks.forEach(chunk => {
        const terms = this.tokenize(getChunkSearchText(chunk));
        chunkLengths.push(terms.length);
        
        const uniqueTerms = new Set(terms);
        uniqueTerms.forEach(term => {
          docFreqs[term] = (docFreqs[term] || 0) + 1;
        });
      });
    }
    
    const avgDocLength = chunkLengths.length > 0
      ? chunkLengths.reduce((a, b) => a + b, 0) / chunkLengths.length
      : 0;
    
    return { docFreqs, avgDocLength, totalDocs: chunks.length };
  }

  /**
   * Build document frequency index by streaming from database
   * This avoids loading all chunks into memory
   * Uses cache if available and valid
   */
  buildDocumentFrequencyIndexFromDB(vectorStore, whereClause = '', params = []) {
    // Check if we can use cached index (only if no filtering)
    if (!whereClause && vectorStore.isDocumentFrequencyIndexCacheValid()) {
      const docFreqs = vectorStore.getCachedDocumentFrequencyIndex();
      const stats = vectorStore.getCachedChunkStatistics();
      return {
        docFreqs,
        avgDocLength: stats.avgDocLength || 0,
        totalDocs: stats.totalDocs || 0
      };
    }
    
    // Build index from scratch
    const docFreqs = {};
    const chunkLengths = [];
    let totalDocs = 0;
    
    vectorStore.getChunksBatched(whereClause, params, {
      batchSize: 1000,
      includeEmbeddings: false,
      includeContent: true,
      includeMetadata: true
    }, (chunks) => {
      chunks.forEach(chunk => {
        const terms = this.tokenize(getChunkSearchText(chunk));
        chunkLengths.push(terms.length);
        totalDocs++;
        
        const uniqueTerms = new Set(terms);
        uniqueTerms.forEach(term => {
          docFreqs[term] = (docFreqs[term] || 0) + 1;
        });
      });
    });
    
    const avgDocLength = chunkLengths.length > 0
      ? chunkLengths.reduce((a, b) => a + b, 0) / chunkLengths.length
      : 0;
    
    // Cache the index if no filtering (so it can be reused)
    if (!whereClause) {
      vectorStore.cacheDocumentFrequencyIndex(docFreqs, avgDocLength, totalDocs);
    }
    
    return { docFreqs, avgDocLength, totalDocs };
  }

  /**
   * Search using BM25 algorithm
   * Optimized to process in batches for large chunk sets
   */
  searchBM25(query, chunks, limit = 10) {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];
    
    const { docFreqs, avgDocLength, totalDocs } = this.buildDocumentFrequencyIndex(chunks);
    
    // Process in batches and maintain top results
    const BATCH_SIZE = 1000;
    const topResults = [];
    
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, Math.min(i + BATCH_SIZE, chunks.length));
      
      const batchResults = batch.map(chunk => {
        const score = this.calculateBM25Score(
          queryTerms,
          getChunkSearchText(chunk),
          avgDocLength,
          totalDocs,
          docFreqs
        );
        return {
          ...chunk,
          score,
          algorithm: 'BM25'
        };
      }).filter(r => r.score > 0);
      
      // Merge with top results
      topResults.push(...batchResults);
      
      // Keep only top N
      if (topResults.length > limit * 2) {
        topResults.sort((a, b) => b.score - a.score);
        topResults.splice(limit);
      }
    }
    
    return topResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Search using BM25 algorithm - streaming from database
   * This avoids loading all chunks into memory
   * Optimized to use cached document frequency index when available
   */
  searchBM25FromDB(vectorStore, query, limit = 10, whereClause = '', params = []) {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];
    
    // Build document frequency index by streaming (uses cache if available)
    const { docFreqs, avgDocLength, totalDocs } = this.buildDocumentFrequencyIndexFromDB(vectorStore, whereClause, params);
    
    if (totalDocs === 0) return [];
    
    // Pre-filter: only process chunks that contain at least one query term
    // This can significantly speed up search for large datasets
    const queryTermsSet = new Set(queryTerms);
    const hasQueryTerm = (chunk) => {
      const lowerContent = getChunkSearchText(chunk).toLowerCase();
      for (const term of queryTermsSet) {
        if (lowerContent.includes(term)) {
          return true;
        }
      }
      return false;
    };
    
    // Search in batches and maintain top results
    const topResults = [];
    let processedCount = 0;
    let skippedCount = 0;
    
    vectorStore.getChunksBatched(whereClause, params, {
      batchSize: 1000,
      includeEmbeddings: false,
      includeContent: true,
      includeMetadata: true
    }, (chunks) => {
      const batchResults = chunks
        .filter(chunk => {
          // Quick pre-filter: skip chunks that don't contain any query terms
          if (!hasQueryTerm(chunk)) {
            skippedCount++;
            return false;
          }
          processedCount++;
          return true;
        })
        .map(chunk => {
          const score = this.calculateBM25Score(
            queryTerms,
            getChunkSearchText(chunk),
            avgDocLength,
            totalDocs,
            docFreqs
          );
          return {
            ...chunk,
            score,
            algorithm: 'BM25'
          };
        })
        .filter(r => r.score > 0);
      
      // Merge with top results
      topResults.push(...batchResults);
      
      // Keep only top N to avoid memory growth
      if (topResults.length > limit * 3) {
        topResults.sort((a, b) => b.score - a.score);
        topResults.splice(limit);
      }
    });
    
    return topResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Search using TF-IDF algorithm
   * Optimized to process in batches for large chunk sets
   */
  searchTFIDF(query, chunks, limit = 10) {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];
    
    const { docFreqs, totalDocs } = this.buildDocumentFrequencyIndex(chunks);
    
    // Process in batches and maintain top results
    const BATCH_SIZE = 1000;
    const topResults = [];
    
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, Math.min(i + BATCH_SIZE, chunks.length));
      
      const batchResults = batch.map(chunk => {
        const score = this.calculateTFIDFScore(
          queryTerms,
          getChunkSearchText(chunk),
          totalDocs,
          docFreqs
        );
        return {
          ...chunk,
          score,
          algorithm: 'TF-IDF'
        };
      }).filter(r => r.score > 0);
      
      // Merge with top results
      topResults.push(...batchResults);
      
      // Keep only top N
      if (topResults.length > limit * 2) {
        topResults.sort((a, b) => b.score - a.score);
        topResults.splice(limit);
      }
    }
    
    return topResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Search using vector similarity
   * Optimized to process in batches for large chunk sets
   */
  searchVector(queryEmbedding, chunks, limit = 10, candidateIds = null) {
    // Filter chunks with embeddings first
    let chunksWithEmbeddings = chunks.filter(chunk => chunk.embedding && chunk.embedding.length > 0);
    
    if (candidateIds && candidateIds.size > 0) {
      const filtered = chunksWithEmbeddings.filter(chunk => candidateIds.has(chunk.id));
      if (filtered.length > 0) {
        chunksWithEmbeddings = filtered;
      }
    }
    
    if (chunksWithEmbeddings.length === 0) return [];
    
    // Process in batches and maintain top results
    const BATCH_SIZE = 500;
    const topResults = [];
    
    for (let i = 0; i < chunksWithEmbeddings.length; i += BATCH_SIZE) {
      const batch = chunksWithEmbeddings.slice(i, Math.min(i + BATCH_SIZE, chunksWithEmbeddings.length));
      
      const batchResults = batch.map(chunk => {
        const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);
        return {
          ...chunk,
          score: similarity,
          algorithm: 'Vector'
        };
      }).filter(r => r.score > 0);
      
      // Merge with top results
      topResults.push(...batchResults);
      
      // Keep only top N
      if (topResults.length > limit * 2) {
        topResults.sort((a, b) => b.score - a.score);
        topResults.splice(limit);
      }
    }
    
    return topResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Search using vector similarity - streaming from database
   * This avoids loading all chunks into memory
   */
  searchVectorFromDB(vectorStore, queryEmbedding, limit = 10, whereClause = 'embedding IS NOT NULL', params = [], options = {}) {
    if (!queryEmbedding) return [];
    
    const {
      chunkIdWhitelist = null
    } = options;
    
    const topResults = [];
    
    const processChunk = (chunk) => {
      if (!chunk.embedding || chunk.embedding.length === 0) {
        return;
      }
      
      const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);
      if (similarity <= 0) {
        return;
      }
      
      topResults.push({
        id: chunk.id,
        document_id: chunk.document_id,
        chunk_index: chunk.chunk_index,
        score: similarity,
        algorithm: 'Vector'
      });
      
      if (topResults.length > limit * 3) {
        topResults.sort((a, b) => b.score - a.score);
        topResults.splice(limit);
      }
    };
    
    if (chunkIdWhitelist && chunkIdWhitelist.length > 0) {
      const candidateChunks = vectorStore.getChunksByIds(chunkIdWhitelist, {
        includeEmbeddings: true,
        includeContent: false,
        includeMetadata: false,
        embeddingAsFloat32: true
      });
      candidateChunks.forEach(processChunk);
    } else {
      vectorStore.getChunksBatched(whereClause, params, {
        batchSize: 500,
        includeEmbeddings: true,
        includeContent: false,
        includeMetadata: false,
        embeddingAsFloat32: true
      }, (chunks) => {
        chunks.forEach(processChunk);
      });
    }
    
    const sortedResults = topResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    return this.attachChunkDetails(vectorStore, sortedResults, {
      includeContent: true,
      includeMetadata: true
    });
  }

  /**
   * Hybrid search combining BM25 and Vector search
   */
  searchHybrid(query, queryEmbedding, chunks, limit = 10, bm25Weight = 0.5, vectorWeight = 0.5) {
    // Get BM25 results
    const bm25Results = this.searchBM25(query, chunks, limit * 2);
    const bm25Map = new Map();
    bm25Results.forEach(r => {
      bm25Map.set(r.id, r.score);
    });
    
    // Get vector results (focus on BM25 candidates)
    const candidateIds = this.buildVectorCandidateSet(bm25Results, limit);
    const vectorResults = this.searchVector(queryEmbedding, chunks, limit * 2, candidateIds);
    const vectorMap = new Map();
    vectorResults.forEach(r => {
      vectorMap.set(r.id, r.score);
    });
    
    // Normalize scores to 0-1 range
    const normalizeScores = (results) => {
      if (results.length === 0) return new Map();
      const maxScore = Math.max(...results.map(r => r.score));
      const minScore = Math.min(...results.map(r => r.score));
      const range = maxScore - minScore || 1;
      
      const normalized = new Map();
      results.forEach(r => {
        normalized.set(r.id, (r.score - minScore) / range);
      });
      return normalized;
    };
    
    const normalizedBM25 = normalizeScores(bm25Results);
    const normalizedVector = normalizeScores(vectorResults);
    
    // Combine scores
    const combinedScores = new Map();
    const allChunkIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);
    
    allChunkIds.forEach(chunkId => {
      const bm25Score = normalizedBM25.get(chunkId) || 0;
      const vectorScore = normalizedVector.get(chunkId) || 0;
      const combinedScore = (bm25Score * bm25Weight) + (vectorScore * vectorWeight);
      combinedScores.set(chunkId, combinedScore);
    });
    
    // Get chunks and combine
    const chunkMap = new Map(chunks.map(c => [c.id, c]));
    const hybridResults = Array.from(combinedScores.entries())
      .map(([chunkId, score]) => {
        const chunk = chunkMap.get(chunkId);
        if (!chunk) return null;
        return {
          ...chunk,
          score,
          algorithm: 'Hybrid',
          bm25Score: normalizedBM25.get(chunkId) || 0,
          vectorScore: normalizedVector.get(chunkId) || 0
        };
      })
      .filter(r => r !== null && r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    return hybridResults;
  }

  /**
   * Hybrid search combining BM25 and Vector search - streaming from database
   * This avoids loading all chunks into memory
   */
  searchHybridFromDB(vectorStore, query, queryEmbedding, limit = 10, bm25Weight = 0.5, vectorWeight = 0.5, whereClause = '', params = []) {
    // Get BM25 results (streaming)
    const bm25Results = this.searchBM25FromDB(vectorStore, query, limit * 2, whereClause, params);
    const bm25Map = new Map();
    bm25Results.forEach(r => {
      bm25Map.set(r.id, r.score);
    });
    
    // Get vector results (streaming) limited to BM25 candidates when possible
    const vectorWhereClause = whereClause ? `${whereClause} AND embedding IS NOT NULL` : 'embedding IS NOT NULL';
    const candidateIds = this.buildVectorCandidateSet(bm25Results, limit);
    const vectorResults = this.searchVectorFromDB(
      vectorStore,
      queryEmbedding,
      limit * 2,
      vectorWhereClause,
      params,
      { chunkIdWhitelist: candidateIds ? Array.from(candidateIds) : null }
    );
    const vectorMap = new Map();
    vectorResults.forEach(r => {
      vectorMap.set(r.id, r.score);
    });
    
    // Normalize scores to 0-1 range
    const normalizeScores = (results) => {
      if (results.length === 0) return new Map();
      const maxScore = Math.max(...results.map(r => r.score));
      const minScore = Math.min(...results.map(r => r.score));
      const range = maxScore - minScore || 1;
      
      const normalized = new Map();
      results.forEach(r => {
        normalized.set(r.id, (r.score - minScore) / range);
      });
      return normalized;
    };
    
    const normalizedBM25 = normalizeScores(bm25Results);
    const normalizedVector = normalizeScores(vectorResults);
    
    // Combine scores
    const combinedScores = new Map();
    const allChunkIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);
    
    allChunkIds.forEach(chunkId => {
      const bm25Score = normalizedBM25.get(chunkId) || 0;
      const vectorScore = normalizedVector.get(chunkId) || 0;
      const combinedScore = (bm25Score * bm25Weight) + (vectorScore * vectorWeight);
      combinedScores.set(chunkId, combinedScore);
    });
    
    // Load only the chunks we need for final results
    const chunkIds = Array.from(combinedScores.keys()).slice(0, limit * 2);
    const chunkMap = new Map();
    
    // Load chunks using vectorStore methods
    for (const chunkId of chunkIds) {
      const chunk = vectorStore.getChunk(chunkId);
      if (chunk) {
        chunkMap.set(chunk.id, chunk);
      }
    }
    
    const hybridResults = Array.from(combinedScores.entries())
      .map(([chunkId, score]) => {
        const chunk = chunkMap.get(chunkId);
        if (!chunk) return null;
        return {
          ...chunk,
          score,
          algorithm: 'Hybrid',
          bm25Score: normalizedBM25.get(chunkId) || 0,
          vectorScore: normalizedVector.get(chunkId) || 0
        };
      })
      .filter(r => r !== null && r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    return hybridResults;
  }

  /**
   * Estimate token count (rough approximation: 1 token ≈ 4 characters)
   */
  estimateTokenCount(text) {
    if (!text || typeof text !== 'string') return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Calculate time decay factor for a chunk based on its creation timestamp
   * Uses exponential decay: decay_factor = 2^(-age_days / half_life_days)
   * @param {number} chunkCreatedAt - Timestamp when chunk was created (milliseconds)
   * @param {number} halfLifeDays - Number of days for half-life
   * @returns {number} Decay factor between 0 and 1
   */
  calculateTimeDecay(chunkCreatedAt, halfLifeDays) {
    if (!chunkCreatedAt || !halfLifeDays || halfLifeDays <= 0) {
      return 1.0; // No decay if invalid parameters
    }
    
    const now = Date.now();
    const ageMs = now - chunkCreatedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    
    // Exponential decay: 2^(-age/half_life)
    // This means after half_life days, the factor is 0.5
    // After 2*half_life days, the factor is 0.25, etc.
    const decayFactor = Math.pow(2, -ageDays / halfLifeDays);
    
    // Clamp between 0 and 1
    return Math.max(0, Math.min(1, decayFactor));
  }

  /**
   * Apply time range filtering to chunks
   * Filters out chunks from documents that haven't been updated within the specified days
   * @param {Array} chunks - Array of chunks with document_id
   * @param {number} sinceDays - Number of days to look back (0 = no filter)
   * @param {Map} documentMap - Map of document_id -> document (with updated_at)
   * @returns {Array} Filtered chunks
   */
  applyTimeRangeFilter(chunks, sinceDays, documentMap) {
    if (!sinceDays || sinceDays <= 0) {
      return chunks; // No filtering if sinceDays is 0 or invalid
    }
    
    const cutoffTime = Date.now() - (sinceDays * 24 * 60 * 60 * 1000);
    
    return chunks.filter(chunk => {
      const doc = documentMap.get(chunk.document_id);
      if (!doc || !doc.updated_at) {
        return true; // Keep chunks if we can't determine document age
      }
      
      // Keep chunks from documents updated within the time range
      return doc.updated_at >= cutoffTime;
    });
  }

  /**
   * Apply time decay to search results
   * Multiplies similarity scores by time decay factor
   * @param {Array} results - Search results with chunks
   * @param {boolean} enabled - Whether time decay is enabled
   * @param {number} halfLifeDays - Half-life in days
   * @returns {Array} Results with decayed scores
   */
  applyTimeDecay(results, enabled, halfLifeDays) {
    if (!enabled || !halfLifeDays || halfLifeDays <= 0) {
      return results; // No decay if disabled or invalid
    }
    
    return results.map(result => {
      // Use chunk's created_at if available, otherwise use current time
      const chunkCreatedAt = result.created_at || Date.now();
      const decayFactor = this.calculateTimeDecay(chunkCreatedAt, halfLifeDays);
      
      return {
        ...result,
        score: result.score * decayFactor,
        originalScore: result.score, // Keep original for reference
        decayFactor: decayFactor
      };
    });
  }

  /**
   * Apply retrieval settings to search results
   */
  applyRetrievalSettings(results, settings = {}) {
    let filtered = [...results];
    
    // Apply score threshold
    if (settings.scoreThreshold && settings.scoreThreshold > 0) {
      filtered = filtered.filter(r => r.score >= settings.scoreThreshold);
    }
    
    // Apply max chunks per document
    if (settings.maxChunksPerDoc && settings.maxChunksPerDoc > 0) {
      const docChunkCounts = new Map();
      filtered = filtered.filter(r => {
        const docId = r.document_id;
        const count = docChunkCounts.get(docId) || 0;
        if (count < settings.maxChunksPerDoc) {
          docChunkCounts.set(docId, count + 1);
          return true;
        }
        return false;
      });
    }
    
    // Apply max context tokens (cap top_k dynamically)
    if (settings.maxContextTokens && settings.maxContextTokens > 0) {
      let totalTokens = 0;
      filtered = filtered.filter(r => {
        const chunkTokens = this.estimateTokenCount(r.content);
        if (totalTokens + chunkTokens <= settings.maxContextTokens) {
          totalTokens += chunkTokens;
          return true;
        }
        return false;
      });
    }
    
    // Group by document if enabled
    if (settings.groupByDoc) {
      const docGroups = new Map();
      filtered.forEach(r => {
        const docId = r.document_id;
        if (!docGroups.has(docId)) {
          docGroups.set(docId, []);
        }
        docGroups.get(docId).push(r);
      });
      
      // Return grouped results (one entry per document with all its chunks)
      filtered = Array.from(docGroups.entries()).map(([docId, chunks]) => {
        const firstChunk = chunks[0];
        return {
          id: firstChunk.id, // Keep first chunk ID for compatibility
          document_id: docId,
          content: firstChunk.content, // Keep first chunk content for compatibility
          chunks: chunks,
          score: Math.max(...chunks.map(c => c.score)), // Use max score for document
          algorithm: chunks[0]?.algorithm || 'Unknown',
          metadata: firstChunk.metadata || {}
        };
      });
    }
    
    // Return full documents if enabled (requires access to document store)
    // This is handled at the RAG service level since we need document info
    
    return filtered;
  }

  /**
   * Attach chunk details (content/metadata) to results when streaming
   */
  attachChunkDetails(vectorStore, results, options = {}) {
    if (!vectorStore || results.length === 0) {
      return results;
    }
    
    const {
      includeContent = true,
      includeMetadata = true
    } = options;
    
    const idsToFetch = results
      .filter(result => {
        const needsContent = includeContent && (result.content === undefined || result.content === null);
        const needsMetadata = includeMetadata && (result.metadata === undefined);
        return needsContent || needsMetadata;
      })
      .map(result => result.id);
    
    if (idsToFetch.length === 0) {
      return results;
    }
    
    const chunkDetails = vectorStore.getChunksByIds(idsToFetch, {
      includeEmbeddings: false,
      includeContent,
      includeMetadata
    });
    
    const detailMap = new Map(chunkDetails.map(chunk => [chunk.id, chunk]));
    
    return results.map(result => {
      const detail = detailMap.get(result.id);
      if (!detail) {
        return result;
      }
      return {
        ...result,
        document_id: detail.document_id || result.document_id,
        chunk_index: detail.chunk_index !== undefined ? detail.chunk_index : result.chunk_index,
        created_at: detail.created_at || result.created_at,
        content: includeContent ? detail.content : result.content,
        metadata: includeMetadata ? detail.metadata : result.metadata
      };
    });
  }

  /**
   * Build candidate set for vector scoring from BM25 results
   */
  buildVectorCandidateSet(bm25Results, limit, multiplier = 4) {
    if (!bm25Results || bm25Results.length === 0 || !limit) {
      return null;
    }
    
    const maxCandidates = Math.max(limit * multiplier, limit);
    const candidateSet = new Set();
    
    for (let i = 0; i < bm25Results.length && candidateSet.size < maxCandidates; i++) {
      candidateSet.add(bm25Results[i].id);
    }
    
    return candidateSet.size > 0 ? candidateSet : null;
  }

  /**
   * Main search method - uses hybrid by default
   * Automatically uses streaming for large datasets (>5000 chunks)
   */
  async search(query, queryEmbedding, chunks, limit = 10, algorithm = 'hybrid', retrievalSettings = {}, metadataSettings = {}, documentMap = null, vectorStore = null) {
    // Use streaming approach for large datasets or if vectorStore is provided
    const useStreaming = vectorStore && (chunks === null || chunks.length > 5000);
    
    if (useStreaming) {
      // Build WHERE clause for time range filtering if needed
      let whereClause = '';
      let params = [];
      
      if (metadataSettings.sinceDays && documentMap) {
        const cutoffTime = Date.now() - (metadataSettings.sinceDays * 24 * 60 * 60 * 1000);
        const docIds = Array.from(documentMap.entries())
          .filter(([_, doc]) => doc.updated_at >= cutoffTime)
          .map(([id, _]) => id);
        
        if (docIds.length > 0) {
          const placeholders = docIds.map(() => '?').join(',');
          whereClause = `document_id IN (${placeholders})`;
          params = docIds;
        } else {
          // No documents in time range, return empty
          return [];
        }
      }
      
      // Perform search using streaming methods
      let results;
      switch (algorithm.toLowerCase()) {
        case 'bm25':
          results = this.searchBM25FromDB(vectorStore, query, limit, whereClause, params);
          break;
        case 'tfidf':
        case 'tf-idf':
          // TF-IDF not yet implemented for streaming, fall back to in-memory
          if (chunks && chunks.length <= 5000) {
            let filteredChunks = chunks;
            if (metadataSettings.sinceDays && documentMap) {
              filteredChunks = this.applyTimeRangeFilter(chunks, metadataSettings.sinceDays, documentMap);
            }
            results = this.searchTFIDF(query, filteredChunks, limit);
          } else {
            // For very large datasets, use BM25 as fallback
            results = this.searchBM25FromDB(vectorStore, query, limit, whereClause, params);
          }
          break;
        case 'vector':
          const vectorWhereClause = whereClause ? `${whereClause} AND embedding IS NOT NULL` : 'embedding IS NOT NULL';
          results = this.searchVectorFromDB(vectorStore, queryEmbedding, limit, vectorWhereClause, params);
          break;
        case 'hybrid':
        default:
          results = this.searchHybridFromDB(vectorStore, query, queryEmbedding, limit, 0.5, 0.5, whereClause, params);
          break;
      }
      
      // Apply time decay to results
      if (metadataSettings.timeDecayEnabled && metadataSettings.timeDecayHalfLifeDays) {
        results = this.applyTimeDecay(results, metadataSettings.timeDecayEnabled, metadataSettings.timeDecayHalfLifeDays);
        results = results.sort((a, b) => b.score - a.score);
      }
      
      // Apply retrieval settings
      if (Object.keys(retrievalSettings).length > 0) {
        results = this.applyRetrievalSettings(results, retrievalSettings);
      }
      
      return results;
    }
    
    // Original in-memory approach for smaller datasets
    // If chunks is null, we shouldn't be in this path, but handle it gracefully
    if (!chunks || chunks.length === 0) {
      return [];
    }
    
    let filteredChunks = chunks;
    
    // Apply time range filtering before search (if documentMap is provided)
    if (metadataSettings.sinceDays && documentMap) {
      filteredChunks = this.applyTimeRangeFilter(chunks, metadataSettings.sinceDays, documentMap);
    }
    
    // Perform search on filtered chunks
    let results;
    switch (algorithm.toLowerCase()) {
      case 'bm25':
        results = this.searchBM25(query, filteredChunks, limit);
        break;
      case 'tfidf':
      case 'tf-idf':
        results = this.searchTFIDF(query, filteredChunks, limit);
        break;
      case 'vector':
        results = this.searchVector(queryEmbedding, filteredChunks, limit);
        break;
      case 'hybrid':
      default:
        results = this.searchHybrid(query, queryEmbedding, filteredChunks, limit);
        break;
    }
    
    // Apply time decay to results (multiplies scores by decay factor)
    if (metadataSettings.timeDecayEnabled && metadataSettings.timeDecayHalfLifeDays) {
      results = this.applyTimeDecay(results, metadataSettings.timeDecayEnabled, metadataSettings.timeDecayHalfLifeDays);
      // Re-sort after applying decay (scores may have changed)
      results = results.sort((a, b) => b.score - a.score);
    }
    
    // Apply retrieval settings (score threshold, max chunks per doc, etc.)
    if (Object.keys(retrievalSettings).length > 0) {
      results = this.applyRetrievalSettings(results, retrievalSettings);
    }
    
    return results;
  }
}

module.exports = { SearchService };

