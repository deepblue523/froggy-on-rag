const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');

const SEARCH_PROFILE_ENABLED = process.env.SEARCH_PROFILE === '1';

class VectorStore {
  constructor(dataDir) {
    this.dbPath = path.join(dataDir, 'vector_store.db');
    this.db = new Database(this.dbPath);
    this.initDatabase();
  }

  initDatabase() {
    // Documents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER,
        ingested_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      )
    `);

    // Chunks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        chunk_index INTEGER NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id)
      )
    `);

    // Document frequency index cache table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_frequency_index (
        term TEXT PRIMARY KEY,
        frequency INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Chunk statistics cache table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_statistics (
        key TEXT PRIMARY KEY,
        value REAL NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
      CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path);
      CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at);
      CREATE INDEX IF NOT EXISTS idx_chunks_created_at ON chunks(created_at);
      CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks((embedding IS NOT NULL));
    `);
  }

  addDocument(document) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO documents 
      (id, file_path, file_name, file_type, file_size, ingested_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const now = Date.now();
    stmt.run(
      document.id,
      document.filePath,
      document.fileName,
      document.fileType,
      document.fileSize,
      document.ingestedAt || now,
      now,
      document.status || 'pending'
    );
  }

  updateDocumentStatus(documentId, status) {
    const stmt = this.db.prepare(`
      UPDATE documents SET status = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(status, Date.now(), documentId);
  }

  addChunks(chunks) {
    const stmt = this.db.prepare(`
      INSERT INTO chunks 
      (id, document_id, content, embedding, chunk_index, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((chunks) => {
      for (const chunk of chunks) {
        stmt.run(
          chunk.id,
          chunk.documentId,
          chunk.content,
          chunk.embedding ? Buffer.from(chunk.embedding) : null,
          chunk.chunkIndex,
          chunk.metadata ? JSON.stringify(chunk.metadata) : null,
          chunk.createdAt || Date.now()
        );
      }
    });

    insertMany(chunks);
    // Invalidate document frequency index cache when chunks are added
    this.invalidateDocumentFrequencyIndex();
  }

  deleteDocumentChunks(documentId) {
    const stmt = this.db.prepare('DELETE FROM chunks WHERE document_id = ?');
    stmt.run(documentId);
    // Invalidate document frequency index cache
    this.invalidateDocumentFrequencyIndex();
  }

  getDocuments() {
    const stmt = this.db.prepare(`
      SELECT d.*,
             (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) AS chunk_count
      FROM documents d
      ORDER BY d.ingested_at DESC
    `);
    return stmt.all();
  }

  getDocument(documentId) {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE id = ?');
    return stmt.get(documentId);
  }

  getDocumentByFilePath(filePath) {
    const normalizedPath = path.resolve(filePath);
    // Query all documents and find by normalized path comparison
    // since file_path might be stored in different formats
    const stmt = this.db.prepare('SELECT * FROM documents');
    const docs = stmt.all();
    return docs.find(doc => path.resolve(doc.file_path) === normalizedPath);
  }

  getDocumentChunks(documentId) {
    const stmt = this.db.prepare(`
      SELECT * FROM chunks 
      WHERE document_id = ? 
      ORDER BY chunk_index ASC
    `);
    const chunks = stmt.all(documentId);
    return chunks.map(chunk => ({
      ...chunk,
      embedding: chunk.embedding ? Array.from(chunk.embedding) : null,
      metadata: chunk.metadata ? JSON.parse(chunk.metadata) : null
    }));
  }

  getChunk(chunkId) {
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE id = ?');
    const chunk = stmt.get(chunkId);
    if (chunk) {
      return {
        ...chunk,
        embedding: chunk.embedding ? Array.from(chunk.embedding) : null,
        metadata: chunk.metadata ? JSON.parse(chunk.metadata) : null
      };
    }
    return null;
  }

  getAllChunks(includeEmbeddings = true) {
    const stmt = this.db.prepare('SELECT * FROM chunks');
    const chunks = stmt.all();
    return chunks.map(chunk => ({
      ...chunk,
      embedding: (includeEmbeddings && chunk.embedding) ? Array.from(chunk.embedding) : null,
      metadata: chunk.metadata ? JSON.parse(chunk.metadata) : null
    }));
  }

  /**
   * Get chunks in batches to avoid loading everything into memory
   * (Convenience wrapper for getChunksBatched without filters)
   */
  getAllChunksBatched(batchSize = 100, includeEmbeddings = true, callback) {
    this.getChunksBatched('', [], { batchSize, includeEmbeddings }, callback);
  }

  /**
   * Get chunks count for memory estimation
   */
  getChunksCount() {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM chunks');
    return stmt.get().count;
  }

  /**
   * Get chunks with optional WHERE clause for filtering
   * Returns chunks in batches via callback
   */
  getChunksBatched(whereClause = '', params = [], options = {}, callback) {
    // Backwards compatibility: allow old signature (batchSize, includeEmbeddings, callback)
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if (typeof options === 'number') {
      options = { batchSize: options };
    }
    
    if (typeof callback !== 'function') {
      throw new Error('Callback is required for getChunksBatched');
    }
    
    const {
      batchSize = 500,
      includeEmbeddings = true,
      includeContent = true,
      includeMetadata = true,
      embeddingAsFloat32 = false,
      selectColumns = null
    } = options;
    
    const profileEnabled = SEARCH_PROFILE_ENABLED;
    const baseFilter = whereClause ? `(${whereClause})` : '1=1';
    const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM chunks WHERE ${baseFilter}`);
    const total = countStmt.get(...params).count;
    
    if (total === 0) {
      callback([], 0, 0);
      return;
    }
    
    const profileLabel = profileEnabled
      ? `chunks${whereClause ? ` [${whereClause.slice(0, 40)}${whereClause.length > 40 ? '…' : ''}]` : ''}`
      : null;
    const profileStart = profileEnabled ? performance.now() : 0;
    let profileBatches = 0;
    let profileRows = 0;
    
    const columns = selectColumns || [
      'id',
      'document_id',
      'chunk_index',
      'created_at',
      includeContent ? 'content' : null,
      includeEmbeddings ? 'embedding' : null,
      includeMetadata ? 'metadata' : null
    ].filter(Boolean).join(', ');
    
    const stmt = this.db.prepare(`
      SELECT rowid as _rowid_, ${columns} FROM chunks 
      WHERE ${baseFilter} AND rowid > ? 
      ORDER BY rowid 
      LIMIT ?
    `);
    
    let lastRowId = 0;
    let processed = 0;
    
    while (true) {
      const chunks = stmt.all(...params, lastRowId, batchSize);
      if (chunks.length === 0) {
        break;
      }
      
      lastRowId = chunks[chunks.length - 1]._rowid_;
      
      const processedChunks = chunks.map(chunk => this.processChunkRow(chunk, {
        includeEmbeddings,
        includeContent,
        includeMetadata,
        embeddingAsFloat32
      }));
      
      const startIndex = processed;
      processed += processedChunks.length;
      
      profileBatches++;
      profileRows += processedChunks.length;
      
      callback(processedChunks, startIndex, total);
    }
    
    if (profileEnabled) {
      const duration = performance.now() - profileStart;
      console.log(`[SearchProfiler] ${profileLabel || 'chunks'} - rows=${profileRows} batches=${profileBatches} duration=${duration.toFixed(2)}ms`);
    }
  }

  /**
   * Get chunks without embeddings (lighter weight for text-based search)
   */
  getAllChunksWithoutEmbeddings() {
    const stmt = this.db.prepare('SELECT id, document_id, content, chunk_index, metadata, created_at FROM chunks');
    const chunks = stmt.all();
    return chunks.map(chunk => ({
      ...chunk,
      metadata: chunk.metadata ? JSON.parse(chunk.metadata) : null
    }));
  }

  searchSimilarChunks(queryEmbedding, limit = 10) {
    const topResults = [];
    
    this.getChunksBatched('embedding IS NOT NULL', [], {
      batchSize: 500,
      includeEmbeddings: true,
      includeContent: true,
      includeMetadata: true,
      embeddingAsFloat32: true
    }, (chunks) => {
      for (const chunk of chunks) {
        const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);
        
        if (topResults.length < limit) {
          topResults.push({
            ...chunk,
            similarity
          });
          if (topResults.length === limit) {
            topResults.sort((a, b) => b.similarity - a.similarity);
          }
        } else if (similarity > topResults[limit - 1].similarity) {
          topResults[limit - 1] = {
            ...chunk,
            similarity
          };
          topResults.sort((a, b) => b.similarity - a.similarity);
        }
      }
    });
    
    return topResults.sort((a, b) => b.similarity - a.similarity);
  }
  /**
   * Get specific chunks by ID (optionally limiting which columns are returned)
   */
  getChunksByIds(chunkIds, options = {}) {
    if (!chunkIds || chunkIds.length === 0) {
      return [];
    }
    
    const uniqueIds = Array.from(new Set(chunkIds));
    
    const {
      includeEmbeddings = false,
      includeContent = true,
      includeMetadata = true,
      embeddingAsFloat32 = false
    } = options;
    
    const columns = [
      'id',
      'document_id',
      'chunk_index',
      'created_at',
      includeContent ? 'content' : null,
      includeEmbeddings ? 'embedding' : null,
      includeMetadata ? 'metadata' : null
    ].filter(Boolean).join(', ');
    
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT ${columns}
      FROM chunks
      WHERE id IN (${placeholders})
    `);
    
    const rows = stmt.all(...uniqueIds);
    
    return rows.map(row => this.processChunkRow(row, {
      includeEmbeddings,
      includeContent,
      includeMetadata,
      embeddingAsFloat32
    }));
  }

  /**
   * Internal helper to process chunk rows consistently
   */
  processChunkRow(row, options = {}) {
    const {
      includeEmbeddings = true,
      includeContent = true,
      includeMetadata = true,
      embeddingAsFloat32 = false
    } = options;
    
    const chunk = {
      id: row.id,
      document_id: row.document_id,
      chunk_index: row.chunk_index,
      created_at: row.created_at
    };
    
    if (includeContent && Object.prototype.hasOwnProperty.call(row, 'content')) {
      chunk.content = row.content;
    }
    
    if (includeMetadata && Object.prototype.hasOwnProperty.call(row, 'metadata')) {
      chunk.metadata = row.metadata ? JSON.parse(row.metadata) : null;
    }
    
    if (includeEmbeddings && Object.prototype.hasOwnProperty.call(row, 'embedding') && row.embedding) {
      if (embeddingAsFloat32) {
        chunk._embeddingBuffer = row.embedding;
        chunk.embedding = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.length / 4
        );
      } else {
        chunk.embedding = Array.from(row.embedding);
      }
    } else {
      chunk.embedding = null;
    }
    
    return chunk;
  }

  cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) return 0;
    
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

  getStats() {
    const docCount = this.db.prepare('SELECT COUNT(*) as count FROM documents').get();
    const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get();
    const totalSize = this.db.prepare('SELECT SUM(file_size) as total FROM documents').get();
    
    return {
      documentCount: docCount.count,
      chunkCount: chunkCount.count,
      totalSize: totalSize.total || 0
    };
  }

  deleteDocument(documentId) {
    const deleteChunks = this.db.prepare('DELETE FROM chunks WHERE document_id = ?');
    const deleteDoc = this.db.prepare('DELETE FROM documents WHERE id = ?');
    
    this.db.transaction(() => {
      deleteChunks.run(documentId);
      deleteDoc.run(documentId);
    })();
    // Invalidate document frequency index cache
    this.invalidateDocumentFrequencyIndex();
  }

  clearStore() {
    // Delete all chunks first (due to foreign key constraint)
    const deleteAllChunks = this.db.prepare('DELETE FROM chunks');
    const deleteAllDocs = this.db.prepare('DELETE FROM documents');
    
    this.db.transaction(() => {
      deleteAllChunks.run();
      deleteAllDocs.run();
    })();
    // Clear cache
    this.invalidateDocumentFrequencyIndex();
  }

  /**
   * Invalidate the document frequency index cache
   */
  invalidateDocumentFrequencyIndex() {
    const deleteDFI = this.db.prepare('DELETE FROM document_frequency_index');
    const deleteStats = this.db.prepare('DELETE FROM chunk_statistics');
    this.db.transaction(() => {
      deleteDFI.run();
      deleteStats.run();
    })();
  }

  /**
   * Get cached document frequency index
   */
  getCachedDocumentFrequencyIndex() {
    const stmt = this.db.prepare('SELECT term, frequency FROM document_frequency_index');
    const rows = stmt.all();
    const docFreqs = {};
    rows.forEach(row => {
      docFreqs[row.term] = row.frequency;
    });
    return docFreqs;
  }

  /**
   * Get cached chunk statistics
   */
  getCachedChunkStatistics() {
    const stmt = this.db.prepare('SELECT key, value FROM chunk_statistics');
    const rows = stmt.all();
    const stats = {};
    rows.forEach(row => {
      stats[row.key] = row.value;
    });
    return stats;
  }

  /**
   * Cache document frequency index and statistics
   */
  /** Bumped when lexical DF / chunk text definition changes (invalidates persisted DF cache). */
  static get DFI_SEARCH_TEXT_VERSION() {
    return 2;
  }

  cacheDocumentFrequencyIndex(docFreqs, avgDocLength, totalDocs) {
    const now = Date.now();
    const insertDFI = this.db.prepare(`
      INSERT OR REPLACE INTO document_frequency_index (term, frequency, updated_at)
      VALUES (?, ?, ?)
    `);
    const insertStats = this.db.prepare(`
      INSERT OR REPLACE INTO chunk_statistics (key, value, updated_at)
      VALUES (?, ?, ?)
    `);

    const cacheMany = this.db.transaction(() => {
      // Clear existing cache
      this.db.prepare('DELETE FROM document_frequency_index').run();
      this.db.prepare('DELETE FROM chunk_statistics').run();
      
      // Insert document frequencies
      for (const [term, frequency] of Object.entries(docFreqs)) {
        insertDFI.run(term, frequency, now);
      }
      
      // Insert statistics
      insertStats.run('avgDocLength', avgDocLength, now);
      insertStats.run('totalDocs', totalDocs, now);
      insertStats.run('dfiSearchTextVersion', VectorStore.DFI_SEARCH_TEXT_VERSION, now);
    });

    cacheMany();
  }

  /**
   * Check if document frequency index cache is valid
   */
  isDocumentFrequencyIndexCacheValid() {
    const dfiCount = this.db.prepare('SELECT COUNT(*) as count FROM document_frequency_index').get().count;
    if (dfiCount === 0) return false;
    const versionRow = this.db.prepare(
      'SELECT value FROM chunk_statistics WHERE key = ?'
    ).get('dfiSearchTextVersion');
    const v = versionRow ? Number(versionRow.value) : 0;
    if (v < VectorStore.DFI_SEARCH_TEXT_VERSION) return false;
    const statsCount = this.db.prepare('SELECT COUNT(*) as count FROM chunk_statistics').get().count;
    return statsCount >= 2; // At least avgDocLength and totalDocs
  }

  close() {
    this.db.close();
  }
}

module.exports = { VectorStore };


