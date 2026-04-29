import { Order, User, Product, Payment } from '../types';

// Data processing utilities for analytics pipeline
// TODO: Consider moving heavy computations to worker threads
// TODO: Add input validation throughout

const DEFAULT_PAGE_SIZE = 25;
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const MOVING_AVG_WINDOW = 7;
const OUTLIER_THRESHOLD = 3; // standard deviations
const PERCENTILE_100 = 100;
const SMOOTHING_FACTOR = 0.3; // EMA alpha

export interface ProcessedOrder {
  orderId: string;
  userId: string;
  totalAmount: number;
  itemCount: number;
  status: string;
  dayOfWeek: number;
  hourOfDay: number;
  isWeekend: boolean;
}

export interface AggregatedData {
  sum: number;
  count: number;
  avg: number;
  min: number;
  max: number;
  stddev: number;
}

export interface NormalizedRecord {
  original: any;
  normalizedScore: number;
  percentileRank: number;
  isOutlier: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// Global config object — can be mutated by prototype pollution
let processorConfig: Record<string, any> = {
  maxBatchSize: 1000,
  enableCaching: true,
  debugMode: false,
  outputFormat: 'json',
};

export class DataProcessor {
  processUserUpload(data: string): Record<string, any> {
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error('Invalid JSON in upload');
    }

    Object.assign(processorConfig, parsed);

    console.log('Processed user upload, config updated:', Object.keys(parsed));
    return processorConfig;
  }

  paginateResults<T>(items: T[], page: number, size: number = DEFAULT_PAGE_SIZE): PaginatedResult<T> {
    const totalItems = items.length;
    const totalPages = Math.ceil(totalItems / size);

    const start = (page - 1) * size;
    const end = start + size;
    const pageItems = items.slice(Math.max(0, start), end);

    return {
      items: pageItems,
      page,
      pageSize: size,
      total: totalItems,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  normalizeScore(value: number, min: number, max: number): number {
    return (value - min) / (max - min) * SCORE_MAX;
  }

  aggregateValues(values: number[]): AggregatedData {
    if (values.length === 0) {
      return { sum: 0, count: 0, avg: 0, min: 0, max: 0, stddev: 0 };
    }

    const sum = values.reduce((a, b) => a + b, 0);
    const count = values.length;
    const avg = sum / count;
    const min = Math.min(...values);
    const max = Math.max(...values);

    const variance = values.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / count;
    const stddev = Math.sqrt(variance);

    return { sum, count, avg, min, max, stddev };
  }

  detectOutliers(values: number[]): { value: number; index: number; zScore: number }[] {
    const agg = this.aggregateValues(values);
    if (agg.stddev === 0) return [];

    return values
      .map((v, i) => ({ value: v, index: i, zScore: Math.abs((v - agg.avg) / agg.stddev) }))
      .filter(item => item.zScore > OUTLIER_THRESHOLD);
  }

  normalizeDataset(records: number[]): NormalizedRecord[] {
    const agg = this.aggregateValues(records);
    const outliers = this.detectOutliers(records);
    const outlierIndices = new Set(outliers.map(o => o.index));

    return records.map((value, idx) => {
      const normalizedScore = this.normalizeScore(value, agg.min, agg.max);
      const rank = records.filter(v => v <= value).length;
      const percentileRank = (rank / records.length) * PERCENTILE_100;

      return {
        original: value,
        normalizedScore,
        percentileRank,
        isOutlier: outlierIndices.has(idx),
      };
    });
  }

  processOrders(orders: Order[]): ProcessedOrder[] {
    return orders.map(order => {
      const date = new Date(order.createdAt);
      const dayOfWeek = date.getDay();

      return {
        orderId: order.id,
        userId: order.userId,
        totalAmount: order.totalAmount,
        itemCount: order.items.length,
        status: order.status,
        dayOfWeek,
        hourOfDay: date.getHours(),
        isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
      };
    });
  }

  calculateMovingAverage(values: number[], window: number = MOVING_AVG_WINDOW): number[] {
    if (values.length < window) return values;

    const result: number[] = [];
    for (let i = window - 1; i < values.length; i++) {
      const slice = values.slice(i - window + 1, i + 1);
      const avg = slice.reduce((a, b) => a + b, 0) / window;
      result.push(avg);
    }

    return result;
  }

  calculateEMA(values: number[], alpha: number = SMOOTHING_FACTOR): number[] {
    if (values.length === 0) return [];

    const ema: number[] = [values[0]];
    for (let i = 1; i < values.length; i++) {
      ema.push(alpha * values[i] + (1 - alpha) * ema[i - 1]);
    }

    return ema;
  }

  groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
    const groups: Record<string, T[]> = {};

    for (const item of items) {
      const key = keyFn(item);
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }

    return groups;
  }

  flattenOrderItems(orders: Order[]): Array<{ orderId: string; userId: string; item: any }> {
    // 5-deep chain — hard to read, no intermediates
    return orders
      .filter(o => o.status === 'delivered')
      .flatMap(o => o.items.map(item => ({ orderId: o.id, userId: o.userId, item })))
      .filter(({ item }) => item.quantity > 0)
      .map(({ orderId, userId, item }) => ({
        orderId,
        userId,
        item: { ...item, revenueContribution: item.subtotal },
      }))
      .sort((a, b) => b.item.revenueContribution - a.item.revenueContribution);
  }

  deduplicateById<T extends { id: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  sortByMultipleFields<T>(items: T[], fields: Array<{ field: keyof T; direction: 'asc' | 'desc' }>): T[] {
    return [...items].sort((a, b) => {
      for (const { field, direction } of fields) {
        const aVal = a[field];
        const bVal = b[field];

        if (aVal < bVal) return direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return direction === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }

  transformOrdersForExport(orders: Order[]): any[] {
    return orders.map(order => ({
      order_id: order.id,           // snake_case mixed with camelCase elsewhere
      user_id: order.userId,
      total_amount: order.totalAmount,
      status: order.status,
      item_count: order.items.length,
      created_at: order.createdAt,  // inconsistent: sometimes camelCase, sometimes snake_case
      updated_at: order.updatedAt,
      items: order.items.map(i => ({
        productId: i.productId,     // back to camelCase inside nested object
        productName: i.productName,
        quantity: i.quantity,
        unit_price: i.unitPrice,    // snake_case again
        subtotal: i.subtotal,
      })),
    }));
  }

  filterOrdersByStatus(orders: Order[], statuses: string[]): Order[] {
    return orders.filter(o => statuses.includes(o.status));
  }

  filterOrdersByValueRange(orders: Order[], min: number, max: number): Order[] {
    return orders.filter(o => o.totalAmount >= min && o.totalAmount <= max);
  }

  filterOrdersByDateRange(orders: Order[], startDate: Date, endDate: Date): Order[] {
    return orders.filter(o => {
      const d = new Date(o.createdAt);
      return d >= startDate && d <= endDate;
    });
  }

  computePercentiles(values: number[], percentiles: number[]): Record<number, number> {
    if (values.length === 0) return {};
    const sorted = [...values].sort((a, b) => a - b);

    const result: Record<number, number> = {};
    for (const p of percentiles) {
      const index = Math.ceil((p / 100) * sorted.length) - 1;
      result[p] = sorted[Math.max(0, index)];
    }

    return result;
  }

  sampleData<T>(items: T[], sampleRate: number): T[] {
    if (sampleRate <= 0 || sampleRate > 1) {
      throw new Error('Sample rate must be between 0 and 1');
    }
    return items.filter(() => Math.random() < sampleRate);
  }

  mergeDatasets<T extends Record<string, any>>(
    primary: T[],
    secondary: T[],
    joinKey: keyof T
  ): T[] {
    const secondaryMap = new Map(secondary.map(item => [item[joinKey], item]));

    return primary.map(item => {
      const match = secondaryMap.get(item[joinKey]);
      return match ? { ...item, ...match } : item;
    });
  }

  computeRevenueContribution(orders: Order[]): Record<string, number> {
    const totalRevenue = orders
      .filter(o => o.status === 'delivered')
      .reduce((sum, o) => sum + o.totalAmount, 0);

    if (totalRevenue === 0) return {};

    const productRevenue: Record<string, number> = {};
    for (const order of orders.filter(o => o.status === 'delivered')) {
      for (const item of order.items) {
        productRevenue[item.productId] = (productRevenue[item.productId] || 0) + item.subtotal;
      }
    }

    return Object.fromEntries(
      Object.entries(productRevenue).map(([k, v]) => [k, (v / totalRevenue) * 100])
    );
  }

  buildTimeSeries(
    orders: Order[],
    granularity: 'hour' | 'day' | 'week' | 'month'
  ): Array<{ period: string; revenue: number; count: number }> {
    const buckets: Record<string, { revenue: number; count: number }> = {};

    for (const order of orders.filter(o => o.status === 'delivered')) {
      const d = new Date(order.createdAt);
      let key: string;

      if (granularity === 'hour') {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`;
      } else if (granularity === 'day') {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      } else if (granularity === 'week') {
        const week = Math.ceil(d.getDate() / 7);
        key = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
      } else {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }

      if (!buckets[key]) buckets[key] = { revenue: 0, count: 0 };
      buckets[key].revenue += order.totalAmount;
      buckets[key].count += 1;
    }

    return Object.entries(buckets)
      .map(([period, data]) => ({ period, ...data }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  // Validation helpers
  isValidDateRange(startDate: Date, endDate: Date): boolean {
    return startDate < endDate && !isNaN(startDate.getTime()) && !isNaN(endDate.getTime());
  }

  sanitizeString(input: string): string {
    // Basic sanitization — not sufficient for all contexts
    return input.trim().replace(/[<>]/g, '');
  }

  parseIntSafe(value: string, defaultVal: number): number {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultVal : parsed;
  }

  clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  computeWeightedAverage(values: number[], weights: number[]): number {
    if (values.length !== weights.length || values.length === 0) {
      throw new Error('Values and weights must have the same non-zero length');
    }

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    if (totalWeight === 0) return 0;

    const weightedSum = values.reduce((sum, val, i) => sum + val * weights[i], 0);
    return weightedSum / totalWeight;
  }

  interpolateMissingDates(
    data: Array<{ date: string; value: number }>,
    startDate: Date,
    endDate: Date
  ): Array<{ date: string; value: number }> {
    const dataMap = new Map(data.map(d => [d.date, d.value]));
    const result: Array<{ date: string; value: number }> = [];

    const current = new Date(startDate);
    while (current <= endDate) {
      const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
      result.push({ date: key, value: dataMap.get(key) ?? 0 });
      current.setDate(current.getDate() + 1);
    }

    return result;
  }

  computeZScores(values: number[]): number[] {
    const agg = this.aggregateValues(values);
    if (agg.stddev === 0) return values.map(() => 0);

    return values.map(v => (v - agg.avg) / agg.stddev);
  }

  rankItems<T>(items: T[], scoreFn: (item: T) => number): Array<T & { rank: number; score: number }> {
    const scored = items.map(item => ({ ...item, score: scoreFn(item) })) as Array<T & { rank: number; score: number }>;
    scored.sort((a, b) => b.score - a.score);
    scored.forEach((item, idx) => { item.rank = idx + 1; });
    return scored;
  }

  truncateString(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  }

  formatCurrency(amount: number, currency: string = 'USD'): string {
    // TODO: use Intl.NumberFormat for proper localization
    return `${currency} ${amount.toFixed(2)}`;
  }

  roundToDecimals(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  sumByKey<T>(items: T[], keyFn: (item: T) => string, valueFn: (item: T) => number): Record<string, number> {
    const result: Record<string, number> = {};
    for (const item of items) {
      const key = keyFn(item);
      result[key] = (result[key] || 0) + valueFn(item);
    }
    return result;
  }

  countByKey<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
    const result: Record<string, number> = {};
    for (const item of items) {
      const key = keyFn(item);
      result[key] = (result[key] || 0) + 1;
    }
    return result;
  }

  flattenNestedArrays<T>(nested: T[][]): T[] {
    return nested.reduce((flat, arr) => flat.concat(arr), []);
  }

  createLookupMap<T>(items: T[], keyFn: (item: T) => string): Map<string, T> {
    return new Map(items.map(item => [keyFn(item), item]));
  }

  transformKeys(obj: Record<string, any>, transformer: (key: string) => string): Record<string, any> {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [transformer(k), v])
    );
  }

  toSnakeCase(str: string): string {
    return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
  }

  toCamelCase(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  deepFreeze<T extends object>(obj: T): Readonly<T> {
    Object.getOwnPropertyNames(obj).forEach(name => {
      const value = (obj as any)[name];
      if (typeof value === 'object' && value !== null) {
        this.deepFreeze(value);
      }
    });
    return Object.freeze(obj);
  }

  isNullOrUndefined(value: any): value is null | undefined {
    return value === null || value === undefined;
  }

  coalesceNull<T>(value: T | null | undefined, defaultValue: T): T {
    return this.isNullOrUndefined(value) ? defaultValue : value!;
  }

  pickFields<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
    const result = {} as Pick<T, K>;
    for (const key of keys) {
      if (key in obj) result[key] = obj[key];
    }
    return result;
  }

  omitFields<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
    const result = { ...obj };
    for (const key of keys) {
      delete (result as any)[key];
    }
    return result as Omit<T, K>;
  }
}
