const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const { convert: htmlToText } = require('html-to-text');
const natural = require('natural');
const { getChunkSearchText } = require('./chunk-search-text');

class DocumentProcessor {
  constructor(embeddingModel, normalizeEmbeddings = true) {
    this.embeddingModel = embeddingModel;
    this.normalizeEmbeddings = normalizeEmbeddings;
    // Initialize tokenizer from natural library for consistency with search
    this.tokenizer = new natural.WordTokenizer();
  }

  async processFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const stats = await fsPromises.stat(filePath);
    
    let content = '';
    // Build namespace from path segments (e.g. C:\this\path\good -> ['this', 'path', 'good'])
    const normalizedPath = path.resolve(filePath);
    let pathSegments = normalizedPath.split(path.sep).filter(Boolean);
    // On Windows, drop leading drive segment (e.g. 'C:') so namespace is just folder/file names
    if (pathSegments.length > 0 && /^[A-Za-z]:$/.test(pathSegments[0])) {
      pathSegments = pathSegments.slice(1);
    }
    const namespace = pathSegments;

    let metadata = {
      filePath,
      fileName: path.basename(filePath),
      fileType: ext,
      fileSize: stats.size,
      modifiedAt: stats.mtimeMs,
      namespace
    };

    try {
      switch (ext) {
        case '.txt':
          content = await fsPromises.readFile(filePath, 'utf-8');
          break;
        
        case '.pdf':
          const pdfData = await fsPromises.readFile(filePath);
          const pdfResult = await pdf(pdfData);
          content = pdfResult.text;
          metadata.pages = pdfResult.numpages;
          break;
        
        case '.docx':
          const docxBuffer = await fsPromises.readFile(filePath);
          const docxResult = await mammoth.extractRawText({ buffer: docxBuffer });
          content = docxResult.value;
          break;
        
        case '.xlsx':
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.readFile(filePath);
          const sheets = [];
          workbook.eachSheet((worksheet) => {
            const sheetData = [];
            worksheet.eachRow((row, rowNumber) => {
              const rowData = row.values.slice(1);
              sheetData.push(rowData.join('\t'));
            });
            sheets.push(`Sheet: ${worksheet.name}\n${sheetData.join('\n')}`);
          });
          content = sheets.join('\n\n');
          metadata.sheetCount = workbook.worksheets.length;
          break;
        
        case '.csv':
          const csvContent = await fsPromises.readFile(filePath, 'utf-8');
          content = csvContent;
          break;
        
        case '.html':
        case '.htm':
          const htmlContent = await fsPromises.readFile(filePath, 'utf-8');
          content = htmlToText(htmlContent, {
            wordwrap: false,
            selectors: [
              { selector: 'script', format: 'skip' },
              { selector: 'style', format: 'skip' },
              { selector: 'noscript', format: 'skip' }
            ]
          });
          break;
        
        default:
          throw new Error(`Unsupported file type: ${ext}`);
      }

      return { content, metadata };
    } catch (error) {
      throw new Error(`Error processing file ${filePath}: ${error.message}`);
    }
  }

  async chunkContent(content, metadata, chunkSize = 1000, overlap = 200, minChunkChars = 0, minChunkTokens = 0, maxChunksPerDocument = 0) {
    // Intelligent chunking with overlap
    const chunks = [];
    const sentences = this.splitIntoSentences(content);
    
    let currentChunk = [];
    let currentLength = 0;

    for (const sentence of sentences) {
      const sentenceLength = sentence.length;
      
      if (currentLength + sentenceLength > chunkSize && currentChunk.length > 0) {
        // Save current chunk
        const chunkContent = currentChunk.join(' ');
        chunks.push({
          id: uuidv4(),
          content: chunkContent,
          chunkIndex: chunks.length,
          metadata: { ...metadata, chunkType: 'text' }
        });

        // Start new chunk with overlap
        const overlapSentences = currentChunk.slice(-Math.floor(overlap / 50));
        currentChunk = overlapSentences;
        currentLength = overlapSentences.join(' ').length;
      }

      currentChunk.push(sentence);
      currentLength += sentenceLength + 1; // +1 for space
    }

    // Add final chunk
    if (currentChunk.length > 0) {
      const chunkContent = currentChunk.join(' ');
      chunks.push({
        id: uuidv4(),
        content: chunkContent,
        chunkIndex: chunks.length,
        metadata: { ...metadata, chunkType: 'text' }
      });
    }

    // Filter chunks by minimum size (chars and tokens)
    let filteredChunks = chunks.filter(chunk => {
      const content = chunk.content;
      const charCount = content.length;
      const tokens = this.tokenizer.tokenize(content) || [];
      const tokenCount = tokens.length;
      
      // Check minimum character count
      if (minChunkChars > 0 && charCount < minChunkChars) {
        return false;
      }
      
      // Check minimum token count
      if (minChunkTokens > 0 && tokenCount < minChunkTokens) {
        return false;
      }
      
      return true;
    });

    // Limit chunks per document if maxChunksPerDocument is set
    if (maxChunksPerDocument > 0 && filteredChunks.length > maxChunksPerDocument) {
      filteredChunks = filteredChunks.slice(0, maxChunksPerDocument);
      // Update chunk indices
      filteredChunks.forEach((chunk, index) => {
        chunk.chunkIndex = index;
      });
    }

    // Generate embeddings for chunks with batching to prevent blocking
    if (this.embeddingModel) {
      const batchSize = 10; // Process 10 chunks at a time
      for (let i = 0; i < filteredChunks.length; i += batchSize) {
        const batch = filteredChunks.slice(i, i + batchSize);
        
        // Process batch concurrently
        await Promise.all(batch.map(async (chunk) => {
          try {
            chunk.embedding = await this.generateEmbedding(
              getChunkSearchText(chunk),
              this.normalizeEmbeddings
            );
          } catch (error) {
            console.error(`Error generating embedding for chunk ${chunk.id}:`, error);
          }
        }));
        
        // Yield to event loop between batches to prevent blocking
        if (i + batchSize < filteredChunks.length) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    }

    return filteredChunks;
  }

  splitIntoSentences(text) {
    // Split by sentence boundaries
    const sentenceRegex = /[.!?]+\s+|[\n\r]+/g;
    const sentences = text.split(sentenceRegex).filter(s => s.trim().length > 0);
    
    // If no sentences found, split by paragraphs or lines
    if (sentences.length === 0) {
      return text.split(/\n+/).filter(s => s.trim().length > 0);
    }
    
    return sentences;
  }

  async generateEmbedding(text, normalize = true) {
    if (!this.embeddingModel) {
      // Fallback: simple token-based embedding (not ideal, but works without model)
      return this.simpleEmbedding(text);
    }

    try {
      const output = await this.embeddingModel(text);
      let embedding = Array.from(output.data);
      
      // Normalize if requested (L2 normalization)
      if (normalize) {
        const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        if (norm > 0) {
          embedding = embedding.map(val => val / norm);
        }
      }
      
      return embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      return this.simpleEmbedding(text);
    }
  }

  simpleEmbedding(text) {
    // Very basic fallback - in production, always use a proper embedding model
    // Use the same tokenizer as search for consistency
    let normalized = text.replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');
    const tokens = this.tokenizer.tokenize(normalized) || [];
    const words = tokens
      .map(token => token.toLowerCase())
      .filter(word => word.length > 0);
    const embedding = new Array(384).fill(0);
    words.forEach((word, idx) => {
      const hash = this.simpleHash(word);
      embedding[hash % embedding.length] += 1;
    });
    // Normalize
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return embedding.map(val => norm > 0 ? val / norm : 0);
  }

  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
}

module.exports = { DocumentProcessor };


