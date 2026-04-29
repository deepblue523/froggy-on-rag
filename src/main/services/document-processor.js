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
const {
  detectDocumentProfile,
  splitStructuredUnits,
  subdivideUnit,
  subdivideMarkdownUnit,
  CODE_LIKE_EXT,
  MARKDOWN_EXT
} = require('./document-chunk-strategies');

const CHUNK_YIELD_INTERVAL = 25;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

        case '.json':
        case '.yaml':
        case '.yml':
          content = await fsPromises.readFile(filePath, 'utf-8');
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

        default: {
          const textExts = new Set([
            ...CODE_LIKE_EXT,
            ...MARKDOWN_EXT,
            '.xml',
            '.toml',
            '.ini',
            '.cfg',
            '.properties',
            '.gradle',
            '.gitignore',
            '.env',
            '.editorconfig'
          ]);
          if (textExts.has(ext)) {
            content = await fsPromises.readFile(filePath, 'utf-8');
            break;
          }
          throw new Error(`Unsupported file type: ${ext}`);
        }
      }

      return { content, metadata };
    } catch (error) {
      throw new Error(`Error processing file ${filePath}: ${error.message}`);
    }
  }

  /**
   * @param {object} [chunkingOptions]
   * @param {boolean} [chunkingOptions.intelligentChunking]
   * @param {boolean} [chunkingOptions.hierarchicalChunking]
   * @param {number} [chunkingOptions.hierarchicalCoarseWindowParts]
   * @param {number} [chunkingOptions.chunkingWholeDocMaxRatio] if doc shorter than chunkSize * ratio, one chunk
   * @param {object | null} [chunkingOptions.llmAdvisor] return value of createLlmChunkAdvisor
   */
  async chunkContent(
    content,
    metadata,
    chunkSize = 1000,
    overlap = 200,
    minChunkChars = 0,
    minChunkTokens = 0,
    maxChunksPerDocument = 0,
    chunkingOptions = {}
  ) {
    const opt = {
      intelligentChunking: chunkingOptions.intelligentChunking !== false,
      hierarchicalChunking: chunkingOptions.hierarchicalChunking === true,
      hierarchicalCoarseWindowParts: Math.max(2, Number(chunkingOptions.hierarchicalCoarseWindowParts) || 3),
      chunkingWholeDocMaxRatio: Number(chunkingOptions.chunkingWholeDocMaxRatio) > 1
        ? Number(chunkingOptions.chunkingWholeDocMaxRatio)
        : 1.15,
      llmAdvisor: chunkingOptions.llmAdvisor || null,
      chunkingLlmParagraphSeams: chunkingOptions.chunkingLlmParagraphSeams === true
    };

    let profile = detectDocumentProfile(content, metadata);
    if (opt.intelligentChunking && opt.llmAdvisor && typeof opt.llmAdvisor.refineProfile === 'function') {
      try {
        const refined = await opt.llmAdvisor.refineProfile(content, metadata, profile);
        if (refined) {
          if (refined.suggestedMaxChars) {
            profile = { ...profile, suggestedChunkSize: refined.suggestedMaxChars };
          }
          if (refined.useWholeDocument) {
            profile = { ...profile, forceWholeDocument: true };
          }
          if (refined.llmNotes) {
            profile = { ...profile, llmNotes: refined.llmNotes };
          }
        }
      } catch (e) {
        console.warn('[chunkContent] LLM profile refine skipped:', e.message);
      }
    }

    await yieldToEventLoop();

    const effectiveSize = Math.max(200, profile.suggestedChunkSize || chunkSize);
    const wholeDocRatio = opt.chunkingWholeDocMaxRatio;

    if (profile.forceWholeDocument || content.length <= effectiveSize * wholeDocRatio) {
      return this._finalizeChunks(
        [
          {
            id: uuidv4(),
            content,
            chunkIndex: 0,
            metadata: {
              ...metadata,
              chunkType: 'whole',
              docProfile: profile.kind,
              docProfileSubkind: profile.subkind
            }
          }
        ],
        minChunkChars,
        minChunkTokens,
        maxChunksPerDocument
      );
    }

    let stringPieces = null;
    if (opt.intelligentChunking) {
      stringPieces = splitStructuredUnits(content, profile);
    }

    if (!stringPieces || stringPieces.length === 0) {
      stringPieces = opt.intelligentChunking
        ? await this._proseParagraphUnits(content, opt)
        : [content];
    }

    const baseStrings = [];
    for (let i = 0; i < stringPieces.length; i++) {
      const piece = stringPieces[i];
      const parts = profile.kind === 'markdown'
        ? subdivideMarkdownUnit(piece, effectiveSize, (t) => this.splitIntoSentences(t))
        : subdivideUnit(piece, effectiveSize, (t) => this.splitIntoSentences(t));
      baseStrings.push(...parts);
      if ((i + 1) % CHUNK_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    let mergedByOverlap = profile.kind === 'markdown'
      ? await this._mergeMarkdownStringsWithOverlap(baseStrings, effectiveSize, overlap, metadata, profile)
      : await this._mergeStringsWithOverlap(baseStrings, effectiveSize, overlap, metadata, profile);

    if (opt.hierarchicalChunking && mergedByOverlap.length > 1) {
      mergedByOverlap = await this._addHierarchicalCoarseChunks(
        mergedByOverlap,
        opt.hierarchicalCoarseWindowParts,
        metadata,
        profile
      );
    }

    return this._finalizeChunks(mergedByOverlap, minChunkChars, minChunkTokens, maxChunksPerDocument);
  }

  async _proseParagraphUnits(content, opt) {
    const paragraphs = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length < 2) {
      return paragraphs.length === 1 ? paragraphs : [content];
    }
    if (opt.chunkingLlmParagraphSeams && opt.llmAdvisor && paragraphs.length >= 6) {
      try {
        const seams = await opt.llmAdvisor.seamIndicesAfterParagraphs(paragraphs);
        if (seams && seams.length > 0) {
          const sorted = [...new Set(seams)].sort((a, b) => a - b);
          const units = [];
          let start = 0;
          for (const b of sorted) {
            if (b > start) {
              units.push(paragraphs.slice(start, b).join('\n\n'));
            }
            start = b;
          }
          if (start < paragraphs.length) {
            units.push(paragraphs.slice(start).join('\n\n'));
          }
          if (units.length) return units;
        }
      } catch (e) {
        console.warn('[chunkContent] LLM paragraph seams skipped:', e.message);
      }
    }
    return paragraphs;
  }

  async _mergeStringsWithOverlap(strings, chunkSize, overlap, metadata, profile) {
    const sentencesFlat = [];
    for (let i = 0; i < strings.length; i++) {
      const s = strings[i];
      const parts = this.splitIntoSentences(s);
      if (parts.length === 0) sentencesFlat.push(s);
      else sentencesFlat.push(...parts);
      if ((i + 1) % CHUNK_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    if (sentencesFlat.length === 0) {
      const fallback = strings.filter(Boolean).join('\n\n').trim();
      if (!fallback) return [];
      return [
        {
          id: uuidv4(),
          content: fallback,
          chunkIndex: 0,
          metadata: {
            ...metadata,
            chunkType: 'text',
            docProfile: profile.kind,
            docProfileSubkind: profile.subkind
          }
        }
      ];
    }

    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;

    for (let i = 0; i < sentencesFlat.length; i++) {
      const sentence = sentencesFlat[i];
      const sentenceLength = sentence.length;
      if (currentLength + sentenceLength > chunkSize && currentChunk.length > 0) {
        chunks.push({
          id: uuidv4(),
          content: currentChunk.join(' '),
          chunkIndex: chunks.length,
          metadata: {
            ...metadata,
            chunkType: 'text',
            docProfile: profile.kind,
            docProfileSubkind: profile.subkind
          }
        });
        const overlapSentences = currentChunk.slice(-Math.max(1, Math.floor(overlap / 50)));
        currentChunk = [...overlapSentences];
        currentLength = overlapSentences.join(' ').length;
      }
      currentChunk.push(sentence);
      currentLength += sentenceLength + 1;
      if ((i + 1) % 100 === 0) {
        await yieldToEventLoop();
      }
    }

    if (currentChunk.length > 0) {
      chunks.push({
        id: uuidv4(),
        content: currentChunk.join(' '),
        chunkIndex: chunks.length,
        metadata: {
          ...metadata,
          chunkType: 'text',
          docProfile: profile.kind,
          docProfileSubkind: profile.subkind
        }
      });
    }

    return chunks;
  }

  async _mergeMarkdownStringsWithOverlap(strings, chunkSize, overlap, metadata, profile) {
    const blocks = strings.map((s) => String(s || '').trim()).filter(Boolean);
    if (blocks.length === 0) return [];

    const chunks = [];
    let current = [];
    let currentLength = 0;

    const makeChunk = (items) => ({
      id: uuidv4(),
      content: items.join('\n\n').trim(),
      chunkIndex: chunks.length,
      metadata: {
        ...metadata,
        chunkType: 'text',
        docProfile: profile.kind,
        docProfileSubkind: profile.subkind
      }
    });

    const overlapItemsFrom = (items) => {
      if (overlap <= 0 || items.length === 0) return [];
      const selected = [];
      let len = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        const itemLen = items[i].length + (selected.length ? 2 : 0);
        if (len + itemLen > overlap) break;
        selected.unshift(items[i]);
        len += itemLen;
        if (len >= overlap) break;
      }
      return selected;
    };

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const addLen = block.length + (current.length ? 2 : 0);
      if (current.length > 0 && currentLength + addLen > chunkSize) {
        chunks.push(makeChunk(current));
        current = overlapItemsFrom(current);
        currentLength = current.join('\n\n').length;
      }
      current.push(block);
      currentLength += block.length + (current.length > 1 ? 2 : 0);
      if ((i + 1) % CHUNK_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    if (current.length > 0) {
      chunks.push(makeChunk(current));
    }

    return chunks;
  }

  async _addHierarchicalCoarseChunks(fineChunks, windowParts, metadata, profile) {
    const out = [];
    let idx = 0;
    for (let i = 0; i < fineChunks.length; i += windowParts) {
      const groupId = uuidv4();
      const slice = fineChunks.slice(i, i + windowParts);
      for (const c of slice) {
        c.metadata = {
          ...c.metadata,
          chunkTier: 'fine',
          chunkGroupId: groupId
        };
        c.chunkIndex = idx++;
        out.push(c);
      }
      const mergedText = slice.map((c) => c.content).join('\n\n').trim();
      if (mergedText && slice.length > 1) {
        out.push({
          id: uuidv4(),
          content: mergedText,
          chunkIndex: idx++,
          metadata: {
            ...metadata,
            chunkType: 'text',
            docProfile: profile.kind,
            docProfileSubkind: profile.subkind,
            chunkTier: 'coarse',
            chunkGroupId: groupId,
            chunkGroupRange: `${i}-${i + slice.length - 1}`
          }
        });
      }
      if (out.length % 100 === 0) {
        await yieldToEventLoop();
      }
    }
    return out;
  }

  async _finalizeChunks(chunks, minChunkChars, minChunkTokens, maxChunksPerDocument) {
    let filteredChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const body = chunk.content;
      const charCount = body.length;
      const tokens = this.tokenizer.tokenize(body) || [];
      const tokenCount = tokens.length;

      if (
        !(minChunkChars > 0 && charCount < minChunkChars) &&
        !(minChunkTokens > 0 && tokenCount < minChunkTokens)
      ) {
        filteredChunks.push(chunk);
      }

      if ((i + 1) % 50 === 0) {
        await yieldToEventLoop();
      }
    }

    if (maxChunksPerDocument > 0 && filteredChunks.length > maxChunksPerDocument) {
      filteredChunks = filteredChunks.slice(0, maxChunksPerDocument);
      filteredChunks.forEach((chunk, index) => {
        chunk.chunkIndex = index;
      });
    }

    if (this.embeddingModel) {
      const batchSize = 10;
      for (let i = 0; i < filteredChunks.length; i += batchSize) {
        const batch = filteredChunks.slice(i, i + batchSize);

        await Promise.all(
          batch.map(async (chunk) => {
            try {
              chunk.embedding = await this.generateEmbedding(
                getChunkSearchText(chunk),
                this.normalizeEmbeddings
              );
            } catch (error) {
              console.error(`Error generating embedding for chunk ${chunk.id}:`, error);
            }
          })
        );

        if (i + batchSize < filteredChunks.length) {
          await yieldToEventLoop();
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


