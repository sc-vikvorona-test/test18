import { Order, User, Product, Payment } from '../types';
import { DataProcessor, AggregatedData } from './dataProcessor';

// Metrics aggregation utilities — combines and summarizes analytics data
// TODO: Add streaming aggregation for very large datasets
// TODO: Consider using a proper time-series store

const DEFAULT_WINDOW_MINUTES = 60;
const BUCKET_COUNT = 12;
const MAX_SERIES_LENGTH = 1000;
const PERCENTILE_BUCKETS = [25, 50, 75, 90, 95, 99];

export interface MetricSnapshot {
  name: string;
  value: number;
  timestamp: Date;
  tags: Record<string, string>;
}

export interface AggregatedMetrics {
  totalRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  uniqueCustomers: number;
  topProductId: string | null;
  revenueByStatus: Record<string, number>;
  ordersByHour: Record<number, number>;
  conversionProxy: number;
}

export interface MetricWindow {
  windowStart: Date;
  windowEnd: Date;
  metrics: AggregatedMetrics;
  sampleCount: number;
}

export interface ComparativeMetrics {
  current: AggregatedMetrics;
  previous: AggregatedMetrics;
  deltas: Record<string, number>;
  percentageChanges: Record<string, number>;
}

export class MetricsAggregator {
  private dataProcessor: DataProcessor;
  private metricHistory: MetricSnapshot[] = [];

  constructor(dataProcessor: DataProcessor) {
    this.dataProcessor = dataProcessor;
  }

  mergeMetrics(a: AggregatedMetrics, b: AggregatedMetrics): AggregatedMetrics {
    a.totalRevenue += b.totalRevenue;
    a.totalOrders += b.totalOrders;
    a.uniqueCustomers += b.uniqueCustomers;
    a.avgOrderValue = a.totalOrders > 0 ? a.totalRevenue / a.totalOrders : 0;

    // Merge revenue by status
    for (const [status, revenue] of Object.entries(b.revenueByStatus)) {
      a.revenueByStatus[status] = (a.revenueByStatus[status] || 0) + revenue;
    }

    // Merge orders by hour
    for (const [hour, count] of Object.entries(b.ordersByHour)) {
      const h = Number(hour);
      a.ordersByHour[h] = (a.ordersByHour[h] || 0) + count;
    }

    a.conversionProxy = (a.conversionProxy + b.conversionProxy) / 2;
    a.topProductId = a.topProductId || b.topProductId;

    return a;
  }

  aggregateInWindow(orders: Order[], windowMinutes: number = DEFAULT_WINDOW_MINUTES): MetricWindow {
    const windowEnd = new Date(Date.now());
    const windowStart = new Date(windowEnd.getTime() - windowMinutes * 60 * 1000);

    const windowOrders = orders.filter(o => {
      const d = new Date(o.createdAt);
      return d >= windowStart && d <= windowEnd;
    });

    const metrics = this.computeAggregatedMetrics(windowOrders);

    return {
      windowStart,
      windowEnd,
      metrics,
      sampleCount: windowOrders.length,
    };
  }

  computeAggregatedMetrics(orders: Order[]): AggregatedMetrics {
    const delivered = orders.filter(o => o.status === 'delivered');
    const totalRevenue = delivered.reduce((sum, o) => sum + o.totalAmount, 0);
    const totalOrders = orders.length;
    const avgOrderValue = delivered.length > 0 ? totalRevenue / delivered.length : 0;

    const uniqueCustomers = new Set(orders.map(o => o.userId)).size;

    // Revenue by status
    const revenueByStatus: Record<string, number> = {};
    for (const order of orders) {
      revenueByStatus[order.status] = (revenueByStatus[order.status] || 0) + order.totalAmount;
    }

    // Orders by hour
    const ordersByHour: Record<number, number> = {};
    for (let h = 0; h < 24; h++) ordersByHour[h] = 0;
    for (const order of orders) {
      const h = new Date(order.createdAt).getHours();
      ordersByHour[h]++;
    }

    // Top product by revenue
    const productRevenue: Record<string, number> = {};
    for (const order of delivered) {
      for (const item of order.items) {
        productRevenue[item.productId] = (productRevenue[item.productId] || 0) + item.subtotal;
      }
    }

    const topProductId = Object.keys(productRevenue).length > 0
      ? Object.entries(productRevenue).sort((a, b) => b[1] - a[1])[0][0]
      : null;

    const conversionProxy = totalOrders > 0 ? (delivered.length / totalOrders) * 100 : 0;

    return {
      totalRevenue,
      totalOrders,
      avgOrderValue,
      uniqueCustomers,
      topProductId,
      revenueByStatus,
      ordersByHour,
      conversionProxy,
    };
  }

  compareMetrics(current: AggregatedMetrics, previous: AggregatedMetrics): ComparativeMetrics {
    const fields: Array<keyof AggregatedMetrics> = [
      'totalRevenue', 'totalOrders', 'avgOrderValue', 'uniqueCustomers', 'conversionProxy'
    ];

    const deltas: Record<string, number> = {};
    const percentageChanges: Record<string, number> = {};

    for (const field of fields) {
      const curr = current[field] as number;
      const prev = previous[field] as number;
      deltas[field] = curr - prev;
      percentageChanges[field] = prev !== 0 ? ((curr - prev) / prev) * 100 : 0;
    }

    return { current, previous, deltas, percentageChanges };
  }

  recordMetricSnapshot(name: string, value: number, tags: Record<string, string> = {}): void {
    const snapshot: MetricSnapshot = {
      name,
      value,
      timestamp: new Date(),
      tags,
    };

    this.metricHistory.push(snapshot);

    // Trim history to prevent unbounded growth
    if (this.metricHistory.length > MAX_SERIES_LENGTH) {
      this.metricHistory = this.metricHistory.slice(-MAX_SERIES_LENGTH);
    }
  }

  getMetricHistory(name: string, limit: number = 100): MetricSnapshot[] {
    return this.metricHistory
      .filter(s => s.name === name)
      .slice(-limit);
  }

  computeRollingMetrics(
    orders: Order[],
    buckets: number = BUCKET_COUNT
  ): MetricWindow[] {
    if (orders.length === 0) return [];

    const times = orders.map(o => new Date(o.createdAt).getTime());
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const bucketSize = (maxTime - minTime) / buckets;

    const windows: MetricWindow[] = [];

    for (let i = 0; i < buckets; i++) {
      const windowStart = new Date(minTime + i * bucketSize);
      const windowEnd = new Date(minTime + (i + 1) * bucketSize);

      const bucketOrders = orders.filter(o => {
        const t = new Date(o.createdAt).getTime();
        return t >= windowStart.getTime() && t < windowEnd.getTime();
      });

      windows.push({
        windowStart,
        windowEnd,
        metrics: this.computeAggregatedMetrics(bucketOrders),
        sampleCount: bucketOrders.length,
      });
    }

    return windows;
  }

  aggregateUserMetrics(orders: Order[]): Record<string, {
    orderCount: number;
    totalSpend: number;
    avgOrderValue: number;
    firstOrder: Date;
    lastOrder: Date;
  }> {
    const userMap: Record<string, Order[]> = {};

    for (const order of orders) {
      if (!userMap[order.userId]) userMap[order.userId] = [];
      userMap[order.userId].push(order);
    }

    const result: Record<string, any> = {};

    for (const [userId, userOrders] of Object.entries(userMap)) {
      const delivered = userOrders.filter(o => o.status === 'delivered');
      const totalSpend = delivered.reduce((sum, o) => sum + o.totalAmount, 0);
      const sorted = userOrders.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      result[userId] = {
        orderCount: userOrders.length,
        totalSpend,
        avgOrderValue: delivered.length > 0 ? totalSpend / delivered.length : 0,
        firstOrder: new Date(sorted[0].createdAt),
        lastOrder: new Date(sorted[sorted.length - 1].createdAt),
      };
    }

    return result;
  }

  getPercentileBreakdown(values: number[]): Record<number, number> {
    return this.dataProcessor.computePercentiles(values, PERCENTILE_BUCKETS);
  }

  computeMovingAverageMetrics(
    orders: Order[],
    window: number = 7
  ): Array<{ date: string; revenue: number; ma: number }> {
    const dailyRevenue: Record<string, number> = {};

    for (const order of orders.filter(o => o.status === 'delivered')) {
      const d = new Date(order.createdAt);
      // TODO: this date format is duplicated in 4 places across the codebase
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dailyRevenue[key] = (dailyRevenue[key] || 0) + order.totalAmount;
    }

    const entries = Object.entries(dailyRevenue).sort((a, b) => a[0].localeCompare(b[0]));
    const revenues = entries.map(([, v]) => v);
    const movingAvg = this.dataProcessor.calculateMovingAverage(revenues, window);
    const offset = revenues.length - movingAvg.length;

    return entries.map(([date, revenue], i) => ({
      date,
      revenue,
      ma: i >= offset ? movingAvg[i - offset] : 0,
    }));
  }

  groupMetricsByTag(snapshots: MetricSnapshot[], tagKey: string): Record<string, MetricSnapshot[]> {
    return this.dataProcessor.groupBy(snapshots, s => s.tags[tagKey] || 'unknown');
  }

  summarizeMetricHistory(name: string): AggregatedData {
    const history = this.getMetricHistory(name, MAX_SERIES_LENGTH);
    const values = history.map(s => s.value);
    return this.dataProcessor.aggregateValues(values);
  }

  computeRevenueHeatmap(orders: Order[]): number[][] {
    // Returns 7x24 grid: [dayOfWeek][hourOfDay] = revenue
    const heatmap: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

    for (const order of orders.filter(o => o.status === 'delivered')) {
      const d = new Date(order.createdAt);
      heatmap[d.getDay()][d.getHours()] += order.totalAmount;
    }

    return heatmap;
  }

  detectAnomalies(orders: Order[], windowDays: number = 7): {
    date: string;
    revenue: number;
    expected: number;
    deviation: number;
    isAnomaly: boolean;
  }[] {
    const timeSeries = this.computeMovingAverageMetrics(orders, windowDays);

    return timeSeries.map(({ date, revenue, ma }) => {
      const deviation = ma > 0 ? Math.abs(revenue - ma) / ma : 0;
      return {
        date,
        revenue,
        expected: ma,
        deviation,
        isAnomaly: deviation > 0.5, // >50% deviation from moving average
      };
    });
  }

  /*
  // OLD: simple sum-based aggregation — replaced by computeAggregatedMetrics
  private _simpleSumAggregation(orders: Order[]) {
    return orders.reduce((acc, o) => {
      acc.total += o.totalAmount;
      acc.count++;
      return acc;
    }, { total: 0, count: 0 });
  }
  */
}
