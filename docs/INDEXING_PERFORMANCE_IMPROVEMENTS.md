# Indexing Performance Improvements

## Problem
The application was hanging when indexing large numbers of files due to blocking operations that prevented the UI from responding.

## Root Causes

### 1. Synchronous File I/O
All file reading operations used `fs.readFileSync()` which blocked the Node.js event loop:
- Text file reading
- PDF parsing
- DOCX extraction
- XLSX workbook reading
- CSV file reading

**Impact**: Each file had to be completely read before the event loop could process other events, causing UI freezes.

### 2. Sequential Embedding Generation
Embeddings were generated one chunk at a time with no batching or yielding:
```javascript
for (const chunk of filteredChunks) {
  chunk.embedding = await this.generateEmbedding(chunk.content);
}
```

**Impact**: Large documents with hundreds of chunks could block the event loop for minutes.

### 3. Single-File Queue Processing
Files were processed completely sequentially - each file had to finish processing before the next one started.

**Impact**: With 1000 files to index, processing was unnecessarily slow and blocked the UI throughout.

## Solutions Implemented

### 1. Asynchronous File I/O
**File**: `src/main/services/document-processor.js`

Converted all file operations to use `fs.promises`:
- `fs.readFileSync()` → `fsPromises.readFile()`
- `fs.statSync()` → `fsPromises.stat()`

**Benefit**: File I/O no longer blocks the event loop, allowing UI updates and other operations to proceed.

### 2. Batched Embedding Generation with Event Loop Yielding
**File**: `src/main/services/document-processor.js`

Implemented batched concurrent processing with periodic yielding:
```javascript
const batchSize = 10; // Process 10 chunks at a time
for (let i = 0; i < filteredChunks.length; i += batchSize) {
  const batch = filteredChunks.slice(i, i + batchSize);
  
  // Process batch concurrently
  await Promise.all(batch.map(async (chunk) => {
    chunk.embedding = await this.generateEmbedding(chunk.content);
  }));
  
  // Yield to event loop between batches
  await new Promise(resolve => setImmediate(resolve));
}
```

**Benefits**:
- 10 embeddings generated concurrently (faster)
- Regular yielding to event loop (responsive UI)
- Prevents blocking on large documents

### 3. Concurrent File Processing
**File**: `src/main/services/rag-service.js`

Implemented concurrent queue processing with configurable concurrency limit:
```javascript
this.maxConcurrentProcessing = 3; // Process up to 3 files concurrently
```

**Benefits**:
- Multiple files processed simultaneously
- Better CPU/GPU utilization
- Faster overall indexing
- Configurable to balance performance vs resource usage

## Performance Improvements

### Before
- **UI Responsiveness**: Froze during indexing
- **File Processing**: Sequential (1 file at a time)
- **Embedding Generation**: Sequential (1 chunk at a time)
- **Event Loop**: Blocked by synchronous I/O

### After
- **UI Responsiveness**: Remains responsive during indexing
- **File Processing**: Concurrent (3 files at a time, configurable)
- **Embedding Generation**: Batched (10 chunks at a time)
- **Event Loop**: Regular yielding, async I/O

### Expected Speed Improvements
- **Small files** (< 10 chunks): 3x faster due to concurrency
- **Large files** (100+ chunks): 5-10x faster due to batched embedding generation
- **UI Updates**: Instant feedback vs frozen interface

## Configuration

### Adjusting Concurrency
In `src/main/services/rag-service.js`, line 35:
```javascript
this.maxConcurrentProcessing = 3; // Increase for more concurrency
```

**Recommendations**:
- **Low-end systems**: 2-3 files
- **Mid-range systems**: 3-5 files
- **High-end systems**: 5-10 files

### Adjusting Batch Size
In `src/main/services/document-processor.js`, line 153:
```javascript
const batchSize = 10; // Increase for more parallelism
```

**Recommendations**:
- **Low memory**: 5-10 chunks
- **Normal systems**: 10-20 chunks
- **High-end systems**: 20-50 chunks

## Monitoring

The ingestion status now includes active processing count:
```javascript
{
  queueLength: 147,
  processing: true,
  activeProcessingCount: 3, // NEW: Shows concurrent files being processed
  queue: [...]
}
```

## Technical Details

### Event Loop Yielding
Using `setImmediate()` instead of `setTimeout(0)` because:
- More efficient for yielding to I/O operations
- Executes after I/O callbacks but before timers
- Better for responsive UIs

### Async File I/O
Using `fs.promises` instead of promisifying `fs` callbacks because:
- Native promise support (Node.js 10+)
- Better error handling
- Cleaner code

### Concurrent Processing Safety
SQLite operations are still synchronous but wrapped in transactions, ensuring:
- No database corruption
- Atomic updates
- Thread-safe operations (better-sqlite3 handles this)

## Future Improvements

### Potential Enhancements
1. **Progress Reporting**: Emit progress events for each chunk processed
2. **Adaptive Concurrency**: Automatically adjust based on system load
3. **Worker Threads**: Move heavy processing to separate threads
4. **Streaming Processing**: Process very large files in chunks
5. **Priority Queue**: Process smaller files first for faster initial results

### Performance Profiling
Enable search profiling to monitor performance:
```javascript
// In settings
searchProfiling: true
```

Or via environment variable:
```bash
SEARCH_PROFILE=1 npm start
```

## Testing

### Verify Non-Blocking Behavior
1. Index a large folder (1000+ files)
2. While indexing, try to:
   - Navigate between tabs
   - Perform searches
   - Adjust settings
   - View documents

UI should remain responsive throughout.

### Performance Benchmarks
Test with:
- 10 small files (< 1MB each)
- 100 medium files (1-10MB each)
- 10 large files (> 10MB each)

Expected improvements:
- Small files: 2-3x faster
- Medium files: 3-5x faster
- Large files: 5-10x faster
- UI: Always responsive

## Related Documentation
- [Memory Optimizations](./MEMORY_OPTIMIZATIONS.md)
- [Search Performance Optimizations](./SEARCH_PERFORMANCE_OPTIMIZATIONS.md)

