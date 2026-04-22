class SearchIndex {
  constructor() {
    this.documents = new Map();
    this.invertedIndex = new Map();
    this.fieldWeights = { title: 3.0, description: 1.0, tags: 2.0 };
  }

  add(id, doc) {
    this.documents.set(id, doc);
    this._index(id, doc);
  }

  remove(id) {
    const doc = this.documents.get(id);
    if (!doc) return;
    this._deindex(id, doc);
    this.documents.delete(id);
  }

  search(query, options = {}) {
    const { limit = 10, offset = 0, fields = Object.keys(this.fieldWeights) } = options;
    const terms = this._tokenize(query);
    const scores = new Map();

    for (const term of terms) {
      for (const field of fields) {
        const key = `${field}:${term}`;
        const postings = this.invertedIndex.get(key) || [];
        const weight = this.fieldWeights[field] || 1.0;
        const idf = Math.log((this.documents.size + 1) / (postings.length + 1));

        for (const { id, tf } of postings) {
          const score = tf * idf * weight;
          scores.set(id, (scores.get(id) || 0) + score);
        }
      }
    }

    const results = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(offset, offset + limit)
      .map(([id, score]) => ({ id, score, doc: this.documents.get(id) }));

    return { total: scores.size, results };
  }

  suggest(prefix, limit = 5) {
    const results = new Set();
    for (const key of this.invertedIndex.keys()) {
      const term = key.split(':')[1];
      if (term.startsWith(prefix.toLowerCase())) {
        results.add(term);
        if (results.size >= limit) break;
      }
    }
    return [...results];
  }

  _index(id, doc) {
    for (const [field, weight] of Object.entries(this.fieldWeights)) {
      const text = doc[field];
      if (!text) continue;
      const terms = this._tokenize(typeof text === 'string' ? text : text.join(' '));
      const termFreqs = {};
      for (const term of terms) {
        termFreqs[term] = (termFreqs[term] || 0) + 1;
      }
      for (const [term, count] of Object.entries(termFreqs)) {
        const key = `${field}:${term}`;
        const postings = this.invertedIndex.get(key) || [];
        postings.push({ id, tf: count / terms.length });
        this.invertedIndex.set(key, postings);
      }
    }
  }

  _deindex(id, doc) {
    for (const field of Object.keys(this.fieldWeights)) {
      const text = doc[field];
      if (!text) continue;
      const terms = this._tokenize(typeof text === 'string' ? text : text.join(' '));
      for (const term of new Set(terms)) {
        const key = `${field}:${term}`;
        const postings = (this.invertedIndex.get(key) || []).filter(p => p.id !== id);
        if (postings.length > 0) this.invertedIndex.set(key, postings);
        else this.invertedIndex.delete(key);
      }
    }
  }

  _tokenize(text) {
    return text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  }

  stats() {
    return {
      documents: this.documents.size,
      terms: this.invertedIndex.size,
    };
  }
}

module.exports = { SearchIndex };


function safeSearch(index, query, options) {
  if (!query || query.trim().length === 0) return { total: 0, results: [] };
  return index.search(query.trim(), options);
}

module.exports.safeSearch = safeSearch;
