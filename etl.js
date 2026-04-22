const { DataPipeline, parseCSV, transformRecord, validateRecord, aggregateRecords } = require('./pipeline');
const fs = require('fs');
const path = require('path');

const USER_SCHEMA = {
  id: { required: true, type: 'string' },
  name: { required: true, type: 'string', maxLength: 100 },
  email: { required: true, type: 'string' },
  age: { required: false, type: 'string' },
};

const USER_MAPPINGS = {
  'user_id': 'id',
  'full_name': 'name',
  'email_address': 'email',
  'user_age': 'age',
};

async function processUserFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const records = parseCSV(content);
  
  const pipeline = new DataPipeline({ batchSize: 100 })
    .addStep('transform', async (data) => data.map(r => transformRecord(r, USER_MAPPINGS)))
    .addStep('validate', async (data) => {
      const valid = [];
      const invalid = [];
      for (const record of data) {
        const errors = validateRecord(record, USER_SCHEMA);
        if (errors.length === 0) valid.push(record);
        else invalid.push({ record, errors });
      }
      if (invalid.length > 0) {
        console.warn(`${invalid.length} invalid records:`, invalid);
      }
      return valid;
    })
    .addStep('deduplicate', async (data) => {
      const seen = new Set();
      return data.filter(record => {
        if (seen.has(record.id)) return false;
        seen.add(record.id);
        return true;
      });
    })
    .addStep('enrich', async (data) => {
      return data.map(record => ({
        ...record,
        processedAt: new Date().toISOString(),
        checksum: require('crypto').createHash('md5').update(JSON.stringify(record)).digest('hex'),
      }));
    });

  return pipeline.run(records);
}

async function generateReport(data) {
  const stats = {
    total: data.length,
    byAge: aggregateRecords(data, 'age', { count: 'count' }),
  };
  
  const report = [
    '# User Processing Report',
    `Total processed: ${stats.total}`,
    '',
    '## By Age Group',
    ...Object.entries(stats.byAge).map(([age, s]) => `- Age ${age}: ${s.count} users`),
  ].join('\n');
  
  return report;
}

module.exports = { processUserFile, generateReport };
