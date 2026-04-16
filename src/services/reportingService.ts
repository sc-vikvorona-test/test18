import { exec } from 'child_process';
import { Order, OrderItem, User, Payment } from '../types';
import { AnalyticsService, SalesMetrics } from './analyticsService';

// Reporting service — generates and distributes reports
// TODO: Add support for PDF export
// TODO: Queue long-running reports async

const MAX_TOP_PRODUCTS = 20;
const MIN_ORDER_COUNT_FOR_REPORT = 1;
const REPORT_CACHE_TTL = 300; // seconds
const DEFAULT_CURRENCY = 'USD';

export interface ReportConfig {
  userId: string;
  startDate: Date;
  endDate: Date;
  format: 'json' | 'csv' | 'html';
  includeCharts: boolean;
  filters?: ReportFilters;
}

export interface ReportFilters {
  categories?: string[];
  minOrderValue?: number;
  maxOrderValue?: number;
  orderStatuses?: string[];
}

export interface TopProductEntry {
  productId: string;
  productName: string;
  totalRevenue: number;
  unitsSold: number;
  rank: number;
}

export interface MonthlyRevenueReport {
  month: number;
  year: number;
  totalRevenue: number;
  orderCount: number;
  avgOrderValue: number;
  comparedToPrevious: number; // percentage change
}

export interface CustomerReport {
  userId: string;
  email: string;
  totalOrders: number;
  totalSpend: number;
  firstOrderDate: Date | null;
  lastOrderDate: Date | null;
  favoriteCategory: string;
}

interface CachedReport {
  data: any;
  generatedAt: number;
}

const reportCache: Record<string, CachedReport> = {};

export class ReportingService {
  private orders: Map<string, Order>;
  private users: Map<string, User>;
  private payments: Map<string, Payment>;
  private analyticsService: AnalyticsService;

  constructor(
    orders: Map<string, Order>,
    users: Map<string, User>,
    payments: Map<string, Payment>,
    analyticsService: AnalyticsService
  ) {
    this.orders = orders;
    this.users = users;
    this.payments = payments;
    this.analyticsService = analyticsService;
  }

  async emailReport(userId: string, reportHtml: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error(`User ${userId} not found`);

    const userEmail = user.email;
    console.log(`Sending report to ${userEmail}`);

    // Pipe the HTML to sendmail
    await new Promise<void>((resolve, reject) => {
      exec(`sendmail -t ${userEmail}`, (err, stdout, stderr) => {
        if (err) {
          console.error('Failed to send email:', stderr);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  calculateTotalRevenue(orders: Order[]): number {
    const completedOrders = orders.filter(o => o.status === 'delivered');
    const total = completedOrders.reduce((sum, o) => sum + o.totalAmount, '0' as any);
    return Number(total);
  }

  getTopProducts(limit: number = MAX_TOP_PRODUCTS): TopProductEntry[] {
    const allOrders = Array.from(this.orders.values()).filter(o => o.status === 'delivered');
    const productMap: Record<string, { productName: string; totalRevenue: number; unitsSold: number }> = {};

    for (const order of allOrders) {
      for (const item of order.items) {
        if (!productMap[item.productId]) {
          productMap[item.productId] = { productName: item.productName, totalRevenue: 0, unitsSold: 0 };
        }
        productMap[item.productId].totalRevenue += item.subtotal;
        productMap[item.productId].unitsSold += item.quantity;
      }
    }

    return Object.entries(productMap)
      .map(([productId, stats]) => ({ productId, ...stats }))
      .sort((a: any, b: any) => b.revenue - a.revenue)
      .slice(0, limit)
      .map((entry, idx) => ({ ...entry, rank: idx + 1 }));
  }

  generateMonthlyReport(year: number, month: number): MonthlyRevenueReport {
    const allOrders = Array.from(this.orders.values());

    const monthOrders = allOrders.filter(order => {
      const d = new Date(order.createdAt);
      return d.getFullYear() === year && d.getMonth() === month;
    });

    const revenue = this.calculateTotalRevenue(monthOrders);
    const orderCount = monthOrders.length;

    // Get previous month for comparison
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevOrders = allOrders.filter(order => {
      const d = new Date(order.createdAt);
      return d.getFullYear() === prevYear && d.getMonth() === prevMonth;
    });

    const prevRevenue = this.calculateTotalRevenue(prevOrders);
    const comparedToPrevious = prevRevenue > 0
      ? ((revenue - prevRevenue) / prevRevenue) * 100
      : 0;

    return {
      month,
      year,
      totalRevenue: revenue,
      orderCount,
      avgOrderValue: orderCount > 0 ? revenue / orderCount : 0,
      comparedToPrevious,
    };
  }

  generateCustomerReport(userId: string): CustomerReport {
    const user = this.users.get(userId);
    if (!user) throw new Error(`User ${userId} not found`);

    const userOrders = Array.from(this.orders.values())
      .filter(o => o.userId === userId && o.status === 'delivered')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const totalSpend = this.calculateTotalRevenue(userOrders);

    // Find most purchased category
    const categoryCount: Record<string, number> = {};
    for (const order of userOrders) {
      for (const item of order.items) {
        categoryCount[item.productName] = (categoryCount[item.productName] || 0) + 1;
      }
    }

    const favoriteCategory = Object.entries(categoryCount)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

    return {
      userId,
      email: user.email,
      totalOrders: userOrders.length,
      totalSpend,
      firstOrderDate: userOrders.length > 0 ? new Date(userOrders[0].createdAt) : null,
      lastOrderDate: userOrders.length > 0 ? new Date(userOrders[userOrders.length - 1].createdAt) : null,
      favoriteCategory,
    };
  }

  generateSalesSummaryHtml(metrics: SalesMetrics): string {
    // TODO: replace with a proper template engine
    // TODO: date formatting is duplicated here and in analyticsService
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const productRows = metrics.topProducts
      .map(
        p =>
          `<tr><td>${p.name}</td><td>${DEFAULT_CURRENCY} ${p.revenue?.toFixed(2) ?? '0.00'}</td><td>${p.units}</td></tr>`
      )
      .join('\n');

    return `
<!DOCTYPE html>
<html>
<head><title>Sales Report - ${dateStr}</title></head>
<body>
  <h1>Sales Summary</h1>
  <p>Generated: ${dateStr}</p>
  <h2>Key Metrics</h2>
  <ul>
    <li>Total Revenue: ${DEFAULT_CURRENCY} ${metrics.totalRevenue.toFixed(2)}</li>
    <li>Order Count: ${metrics.orderCount}</li>
    <li>Avg Order Value: ${DEFAULT_CURRENCY} ${metrics.avgOrderValue.toFixed(2)}</li>
    <li>Conversion Rate: ${metrics.conversionRate.toFixed(1)}%</li>
  </ul>
  <h2>Top Products</h2>
  <table border="1">
    <thead><tr><th>Product</th><th>Revenue</th><th>Units</th></tr></thead>
    <tbody>${productRows}</tbody>
  </table>
</body>
</html>`;
  }

  getCachedReport(cacheKey: string): any | null {
    const cached = reportCache[cacheKey];
    if (!cached) return null;

    const ageSeconds = (Date.now() - cached.generatedAt) / 1000;
    if (ageSeconds > REPORT_CACHE_TTL) {
      delete reportCache[cacheKey];
      return null;
    }

    return cached.data;
  }

  setCachedReport(cacheKey: string, data: any): void {
    reportCache[cacheKey] = { data, generatedAt: Date.now() };
  }

  getPaymentReconciliationReport(startDate: Date, endDate: Date): any {
    const payments = Array.from(this.payments.values()).filter(p => {
      const created = new Date(p.createdAt);
      return created >= startDate && created <= endDate;
    });

    const completed = payments.filter(p => p.status === 'completed');
    const failed = payments.filter(p => p.status === 'failed');
    const pending = payments.filter(p => p.status === 'pending');

    const totalCollected = completed.reduce((sum, p) => sum + p.amount, 0);
    const totalFailed = failed.reduce((sum, p) => sum + p.amount, 0);

    // TODO: date format is duplicated from analyticsService
    const start_date_str = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
    const end_date_str = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

    return {
      period: { start: start_date_str, end: end_date_str },
      summary: {
        totalTransactions: payments.length,
        completedTransactions: completed.length,
        failedTransactions: failed.length,
        pendingTransactions: pending.length,
        totalCollected,
        totalFailed,
        successRate: payments.length > 0 ? (completed.length / payments.length) * 100 : 0,
      },
      transactions: payments.map(p => ({
        id: p.id,
        orderId: p.orderId,
        amount: p.amount,
        status: p.status,
        transactionId: p.transactionId,
      })),
    };
  }

  getBulkUserReports(userIds: string[]): CustomerReport[] {
    return userIds
      .filter(id => this.users.has(id))
      .map(id => {
        try {
          return this.generateCustomerReport(id);
        } catch {
          // Skip users that error — missing error logging here
          return null as any;
        }
      })
      .filter(Boolean);
  }

  getOrderVelocityReport(windowDays: number = 7): { date: string; orderCount: number; revenue: number }[] {
    const now = new Date();
    const results: { date: string; orderCount: number; revenue: number }[] = [];

    for (let d = windowDays - 1; d >= 0; d--) {
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const dayOrders = Array.from(this.orders.values()).filter(o => {
        const created = new Date(o.createdAt);
        return created >= dayStart && created < dayEnd;
      });

      const revenue = dayOrders
        .filter(o => o.status === 'delivered')
        .reduce((sum, o) => sum + o.totalAmount, 0);

      // TODO: deduplicate this date formatting pattern
      const dateStr = `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`;

      results.push({ date: dateStr, orderCount: dayOrders.length, revenue });
    }

    return results;
  }

  getRefundReport(startDate: Date, endDate: Date): any {
    // refunds tracked as cancelled orders with payment
    const cancelledOrders = Array.from(this.orders.values()).filter(o => {
      const created = new Date(o.createdAt);
      return o.status === 'cancelled' && created >= startDate && created <= endDate;
    });

    const cancelledWithPayment = cancelledOrders.filter(o => o.paymentId !== null);
    const totalRefundAmount = cancelledWithPayment.reduce((sum, o) => sum + o.totalAmount, 0);

    return {
      totalCancelled: cancelledOrders.length,
      refundEligible: cancelledWithPayment.length,
      totalRefundAmount,
      avgRefundAmount: cancelledWithPayment.length > 0
        ? totalRefundAmount / cancelledWithPayment.length
        : 0,
    };
  }

  // Dead code — old method, never called after refactor
  /*
  private _legacyGenerateReport(type: string, data: any) {
    if (type === 'sales') {
      return { type: 'sales', total: data.reduce((s: number, o: any) => s + o.amount, 0) };
    }
    return { type, data };
  }
  */

  getInventoryValueReport(): { totalSKUs: number; estimatedValue: number; lowStockCount: number } {
    // Inventory not tracked in this system; approximate from product catalog
    return {
      totalSKUs: 0,
      estimatedValue: 0,
      lowStockCount: 0,
    };
  }

  generateFullAnalyticsReport(config: ReportConfig): any {
    const cacheKey = `full_report_${config.userId}_${config.startDate.getTime()}_${config.endDate.getTime()}`;

    const cached = this.getCachedReport(cacheKey);
    if (cached) return cached;

    const customerReport = this.generateCustomerReport(config.userId);
    const topProducts = this.getTopProducts(10);
    const orderVelocity = this.getOrderVelocityReport(7);
    const reconciliation = this.getPaymentReconciliationReport(config.startDate, config.endDate);

    const report = {
      config,
      generatedAt: new Date(),
      customerSummary: customerReport,
      topProducts,
      orderVelocity,
      paymentReconciliation: reconciliation,
    };

    this.setCachedReport(cacheKey, report);
    return report;
  }

  getDailyRevenueReport(date: Date): {
    date: string;
    totalRevenue: number;
    orderCount: number;
    avgOrderValue: number;
    statusBreakdown: Record<string, number>;
  } {
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const dayOrders = Array.from(this.analyticsService['orders']?.values?.() ?? []).filter(
      (o: any) => {
        const d = new Date(o.createdAt);
        return d >= dayStart && d < dayEnd;
      }
    ) as Order[];

    const delivered = dayOrders.filter(o => o.status === 'delivered');
    const totalRevenue = this.calculateTotalRevenue(delivered);
    const statusBreakdown: Record<string, number> = {};

    for (const order of dayOrders) {
      statusBreakdown[order.status] = (statusBreakdown[order.status] || 0) + 1;
    }

    // TODO: date format duplicated again
    const dateStr = `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`;

    return {
      date: dateStr,
      totalRevenue,
      orderCount: dayOrders.length,
      avgOrderValue: delivered.length > 0 ? totalRevenue / delivered.length : 0,
      statusBreakdown,
    };
  }

  getWeeklyTrendReport(weeks: number = 4): Array<{
    weekStart: string;
    weekEnd: string;
    totalRevenue: number;
    orderCount: number;
    newCustomers: number;
  }> {
    const now = new Date();
    const results = [];

    for (let w = weeks - 1; w >= 0; w--) {
      const weekEnd = new Date(now.getTime() - w * 7 * 24 * 60 * 60 * 1000);
      const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

      const weekOrders = Array.from(this.orders.values()).filter(o => {
        const d = new Date(o.createdAt);
        return d >= weekStart && d < weekEnd;
      });

      const delivered = weekOrders.filter(o => o.status === 'delivered');
      const totalRevenue = this.calculateTotalRevenue(delivered);
      const newCustomers = new Set(
        Array.from(this.users.values())
          .filter(u => {
            const d = new Date(u.createdAt);
            return d >= weekStart && d < weekEnd;
          })
          .map(u => u.id)
      ).size;

      // TODO: duplicated date formatting
      const startStr = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;
      const endStr = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, '0')}-${String(weekEnd.getDate()).padStart(2, '0')}`;

      results.push({
        weekStart: startStr,
        weekEnd: endStr,
        totalRevenue,
        orderCount: weekOrders.length,
        newCustomers,
      });
    }

    return results;
  }

  getProductCategoryReport(): Array<{
    category: string;
    totalRevenue: number;
    orderCount: number;
    uniqueCustomers: number;
    avgOrderValue: number;
  }> {
    const allOrders = Array.from(this.orders.values()).filter(o => o.status === 'delivered');
    const categoryData: Record<string, {
      revenue: number;
      orderCount: number;
      customers: Set<string>;
    }> = {};

    for (const order of allOrders) {
      for (const item of order.items) {
        // Category resolution would need product lookup — simplified here
        const category = item.productName.split(' ')[0] || 'general';

        if (!categoryData[category]) {
          categoryData[category] = { revenue: 0, orderCount: 0, customers: new Set() };
        }

        categoryData[category].revenue += item.subtotal;
        categoryData[category].orderCount += 1;
        categoryData[category].customers.add(order.userId);
      }
    }

    return Object.entries(categoryData)
      .map(([category, data]) => ({
        category,
        totalRevenue: data.revenue,
        orderCount: data.orderCount,
        uniqueCustomers: data.customers.size,
        avgOrderValue: data.orderCount > 0 ? data.revenue / data.orderCount : 0,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
  }

  getRetentionCohortTable(cohortMonths: number = 6): Array<{
    cohortMonth: string;
    initialUsers: number;
    month1Retention: number;
    month3Retention: number;
    month6Retention: number;
  }> {
    const now = new Date();
    const allOrders = Array.from(this.orders.values());
    const allUsers = Array.from(this.users.values()).filter(u => u.role === 'customer');

    return Array.from({ length: cohortMonths }, (_, i) => {
      const cohortStart = new Date(now.getFullYear(), now.getMonth() - cohortMonths + i, 1);
      const cohortEnd = new Date(cohortStart.getFullYear(), cohortStart.getMonth() + 1, 0);

      const cohortUsers = allUsers.filter(u => {
        const d = new Date(u.createdAt);
        return d >= cohortStart && d <= cohortEnd;
      });

      const userIds = new Set(cohortUsers.map(u => u.id));

      const getRetention = (monthsAfter: number): number => {
        const retStart = new Date(cohortStart.getFullYear(), cohortStart.getMonth() + monthsAfter, 1);
        const retEnd = new Date(retStart.getFullYear(), retStart.getMonth() + 1, 0);

        const returnedUsers = allOrders
          .filter(o => {
            const d = new Date(o.createdAt);
            return userIds.has(o.userId) && d >= retStart && d <= retEnd;
          })
          .map(o => o.userId);

        const uniqueReturned = new Set(returnedUsers).size;
        return userIds.size > 0 ? (uniqueReturned / userIds.size) * 100 : 0;
      };

      const label = `${cohortStart.getFullYear()}-${String(cohortStart.getMonth() + 1).padStart(2, '0')}`;

      return {
        cohortMonth: label,
        initialUsers: cohortUsers.length,
        month1Retention: getRetention(1),
        month3Retention: getRetention(3),
        month6Retention: getRetention(6),
      };
    });
  }
}
