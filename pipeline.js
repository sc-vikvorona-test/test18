const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DataPipeline {
  constructor(config) {
    this.config = config;
    this.steps = [];
    this.results = [];
  }

  addStep(name, fn) {
    this.steps.push({ name, fn });
    return this;
  }

  async run(input) {
    let data = input;
    for (const step of this.steps) {
      try {
        data = await step.fn(data);
        this.results.push({ step: step.name, success: true, output: data });
      } catch (err) {
        this.results.push({ step: step.name, success: false, error: err.message });
        throw err;
      }
    }
    return data;
  }
}

function parseCSV(content) {
  const lines = content.split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    return headers.reduce((obj, header, i) => {
      obj[header.trim()] = values[i] ? values[i].trim() : '';
      return obj;
    }, {});
  });
}

function transformRecord(record, mappings) {
  const result = {};
  for (const [sourceKey, targetKey] of Object.entries(mappings)) {
    result[targetKey] = record[sourceKey];
  }
  return result;
}

function validateRecord(record, schema) {
  const errors = [];
  for (const [field, rules] of Object.entries(schema)) {
    if (rules.required && !record[field]) {
      errors.push(`Missing required field: ${field}`);
    }
    if (rules.type && typeof record[field] !== rules.type) {
      errors.push(`Invalid type for ${field}: expected ${rules.type}`);
    }
    if (rules.maxLength && record[field] && record[field].length > rules.maxLength) {
      errors.push(`${field} exceeds max length of ${rules.maxLength}`);
    }
  }
  return errors;
}

function aggregateRecords(records, groupBy, aggregations) {
  const groups = {};
  for (const record of records) {
    const key = record[groupBy];
    if (!groups[key]) groups[key] = [];
    groups[key].push(record);
  }
  
  const results = {};
  for (const [key, group] of Object.entries(groups)) {
    results[key] = {};
    for (const [field, op] of Object.entries(aggregations)) {
      const values = group.map(r => parseFloat(r[field])).filter(v => !isNaN(v));
      switch (op) {
        case 'sum': results[key][field] = values.reduce((a, b) => a + b, 0); break;
        case 'avg': results[key][field] = values.reduce((a, b) => a + b, 0) / values.length; break;
        case 'max': results[key][field] = Math.max(...values); break;
        case 'min': results[key][field] = Math.min(...values); break;
        case 'count': results[key][field] = group.length; break;
      }
    }
  }
  return results;
}

module.exports = { DataPipeline, parseCSV, transformRecord, validateRecord, aggregateRecords };
