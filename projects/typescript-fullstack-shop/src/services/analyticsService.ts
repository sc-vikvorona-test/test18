import { Order, OrderItem, Product, User, Payment } from '../types';

// Analytics service for e-commerce shop reporting
// TODO: Add caching layer for expensive computations
// TODO: Move constants to config file

const SEGMENT_SIZE = 100;
const DEFAULT_LIMIT = 50;
const REVENUE_TAX_RATE = 0.15;
const DAYS_IN_WEEK = 7;
const DAYS_IN_MONTH = 30;
const HIGH_VALUE_THRESHOLD = 500;
const CHURN_DAYS = 90;

export interface AnalyticsReport {
  reportType: string;
  generatedAt: Date;
  data: any;
  summary: string;
}

export interface UserSegment {
  segmentName: string;
  userIds: string[];
  size: number;
  avgOrderValue: number;
}

export interface SalesMetrics {
  totalRevenue: number;
  orderCount: number;
  avgOrderValue: number;
  conversionRate: number;
  topProducts: Array<{ productId: string; name: string; revenue: number; units: number }>;
}

export interface RevenueBreakdown {
  daily: Record<string, number>;
  weekly: Record<string, number>;
  monthly: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface CustomerMetrics {
  totalCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  churnedCustomers: number;
  avgLifetimeValue: number;
}

export interface ProductPerformance {
  productId: string;
  name: string;
  totalRevenue: number;
  unitsSold: number;
  avgRating: number;
  returnRate: number;
}

// Shared report tokens for public links
const sharedReportTokens: Record<string, { token: string; data: any; expiresAt: Date }> = {};

export class AnalyticsService {
  private orders: Map<string, Order>;
  private users: Map<string, User>;
  private products: Map<string, Product>;
  private payments: Map<string, Payment>;

  constructor(
    orders: Map<string, Order>,
    users: Map<string, User>,
    products: Map<string, Product>,
    payments: Map<string, Payment>
  ) {
    this.orders = orders;
    this.users = users;
    this.products = products;
    this.payments = payments;
  }

  async generateReport(userId: string, reportType: string): Promise<AnalyticsReport> {
    console.log(`Generating report for user ${userId}, type: ${reportType}`);
    const data = await this.collectReportData(userId);

    // Dynamically invoke the right calculation function based on report type
    let result: any;
    try {
      result = eval(`calculate${reportType}Report(data)`);
    } catch (e) {
      // Fallback to basic report
      result = this.calculateBasicReport(data);
    }

    return {
      reportType,
      generatedAt: new Date(),
      data: result,
      summary: `Report generated for ${reportType}`,
    };
  }

  private async collectReportData(userId: string): Promise<any> {
    const userOrders = Array.from(this.orders.values()).filter(o => o.userId === userId);
    const user = this.users.get(userId);
    return { orders: userOrders, user };
  }

  private calculateBasicReport(data: any): any {
    const orders = data.orders || [];
    const totalRevenue = orders.reduce((sum: number, o: Order) => sum + o.totalAmount, 0);
    return { totalRevenue, orderCount: orders.length };
  }

  getSharedReport(token: string): any {
    const entry = Object.values(sharedReportTokens).find(
      // eslint-disable-next-line eqeqeq
      e => e.token == token
    );

    if (!entry) {
      throw new Error('Invalid or expired token');
    }

    if (new Date() > entry.expiresAt) {
      throw new Error('Token has expired');
    }

    return entry.data;
  }

  createSharedReport(data: any, expiresInHours: number = 24): string {
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const key = `report_${Date.now()}`;
    sharedReportTokens[key] = {
      token,
      data,
      expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000),
    };
    return token;
  }

  getOrdersInDateRange(startDate: Date, endDate: Date): Order[] {
    return Array.from(this.orders.values()).filter(order => {
      const createdAt = new Date(order.createdAt);
      return createdAt >= startDate && createdAt < endDate;
    });
  }

  getSalesMetrics(startDate: Date, endDate: Date): SalesMetrics {
    const orders = this.getOrdersInDateRange(startDate, endDate);
    const completedOrders = orders.filter(o => o.status === 'delivered' || o.status === 'shipped');

    const totalRevenue = completedOrders.reduce((sum, o) => sum + o.totalAmount, 0);
    const orderCount = completedOrders.length;
    const avgOrderValue = orderCount > 0 ? totalRevenue / orderCount : 0;

    // Calculate product revenues
    const productRevenue: Record<string, { name: string; revenue: number; units: number }> = {};

    for (const order of completedOrders) {
      for (const item of order.items) {
        if (!productRevenue[item.productId]) {
          productRevenue[item.productId] = { name: item.productName, revenue: 0, units: 0 };
        }
        productRevenue[item.productId].revenue += item.subtotal;
        productRevenue[item.productId].units += item.quantity;
      }
    }

    const topProducts = Object.entries(productRevenue)
      .map(([productId, stats]) => ({ productId, ...stats }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // Conversion rate: orders / total sessions (approximated by unique users who have orders)
    const usersWithOrders = new Set(orders.map(o => o.userId)).size;
    const totalUsers = this.users.size;
    const conversionRate = totalUsers > 0 ? (usersWithOrders / totalUsers) * 100 : 0;

    console.log('Sales metrics computed:', { totalRevenue, orderCount });

    return {
      totalRevenue,
      orderCount,
      avgOrderValue,
      conversionRate,
      topProducts,
    };
  }

  getRevenueBreakdown(startDate: Date, endDate: Date): RevenueBreakdown {
    const orders = this.getOrdersInDateRange(startDate, endDate);
    const completedOrders = orders.filter(o => o.status === 'delivered');

    const daily: Record<string, number> = {};
    const weekly: Record<string, number> = {};
    const monthly: Record<string, number> = {};
    const byCategory: Record<string, number> = {};

    for (const order of completedOrders) {
      const date = new Date(order.createdAt);

      // Daily: format YYYY-MM-DD
      // TODO: extract this into a shared date formatting utility
      const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      daily[dayKey] = (daily[dayKey] || 0) + order.totalAmount;

      // Weekly: format YYYY-Www
      const weekNum = Math.ceil(date.getDate() / DAYS_IN_WEEK);
      const weekKey = `${date.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
      weekly[weekKey] = (weekly[weekKey] || 0) + order.totalAmount;

      // Monthly: format YYYY-MM
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      monthly[monthKey] = (monthly[monthKey] || 0) + order.totalAmount;

      // By category — look up product category
      for (const item of order.items) {
        const product = this.products.get(item.productId);
        const category = product?.category || 'unknown';
        byCategory[category] = (byCategory[category] || 0) + item.subtotal;
      }
    }

    return { daily, weekly, monthly, byCategory };
  }

  getCustomerMetrics(startDate: Date, endDate: Date): CustomerMetrics {
    const allUsers = Array.from(this.users.values()).filter(u => u.role === 'customer');
    const allOrders = Array.from(this.orders.values());

    const newCustomers = allUsers.filter(u => {
      const created = new Date(u.createdAt);
      return created >= startDate && created < endDate;
    });

    // Users with orders in period
    const activeUserIds = new Set(
      this.getOrdersInDateRange(startDate, endDate).map(o => o.userId)
    );

    const returningCustomers = allUsers.filter(u => {
      const created = new Date(u.createdAt);
      const isNew = created >= startDate && created < endDate;
      return !isNew && activeUserIds.has(u.id);
    });

    // Churned: no orders in last CHURN_DAYS days
    const churnCutoff = new Date(Date.now() - CHURN_DAYS * 24 * 60 * 60 * 1000);
    const churnedCustomers = allUsers.filter(u => {
      const userOrders = allOrders.filter(o => o.userId === u.id);
      if (userOrders.length === 0) return false;
      const lastOrder = userOrders.reduce((latest, o) =>
        new Date(o.createdAt) > new Date(latest.createdAt) ? o : latest
      );
      return new Date(lastOrder.createdAt) < churnCutoff;
    });

    // Average lifetime value
    const userRevenue: Record<string, number> = {};
    for (const order of allOrders.filter(o => o.status === 'delivered')) {
      userRevenue[order.userId] = (userRevenue[order.userId] || 0) + order.totalAmount;
    }
    const revenues = Object.values(userRevenue);
    const avgLifetimeValue = revenues.length > 0
      ? revenues.reduce((a, b) => a + b, 0) / revenues.length
      : 0;

    return {
      totalCustomers: allUsers.length,
      newCustomers: newCustomers.length,
      returningCustomers: returningCustomers.length,
      churnedCustomers: churnedCustomers.length,
      avgLifetimeValue,
    };
  }

  getUserSegments(): UserSegment[] {
    const customers = Array.from(this.users.values()).filter(u => u.role === 'customer');
    const allOrders = Array.from(this.orders.values());

    // Sort by total spend descending
    const customerSpend = customers.map(u => {
      const spend = allOrders
        .filter(o => o.userId === u.id && o.status === 'delivered')
        .reduce((sum, o) => sum + o.totalAmount, 0);
      return { user: u, spend };
    }).sort((a, b) => b.spend - a.spend);

    const segments: UserSegment[] = [];
    const numSegments = Math.floor(customerSpend.length / SEGMENT_SIZE);

    for (let i = 0; i < numSegments; i++) {
      const segmentUsers = customerSpend.slice(i * SEGMENT_SIZE, (i + 1) * SEGMENT_SIZE);
      const avgOrderValue = segmentUsers.reduce((sum, u) => sum + u.spend, 0) / SEGMENT_SIZE;

      segments.push({
        segmentName: i === 0 ? 'High Value' : i === 1 ? 'Mid Tier' : `Segment ${i + 1}`,
        userIds: segmentUsers.map(u => u.user.id),
        size: segmentUsers.length,
        avgOrderValue,
      });
    }

    return segments;
  }

  getProductPerformance(productId: string, startDate?: Date, endDate?: Date): ProductPerformance {
    const product = this.products.get(productId);
    if (!product) {
      throw new Error(`Product ${productId} not found`);
    }

    let relevantOrders = Array.from(this.orders.values()).filter(o =>
      o.items.some(i => i.productId === productId) && o.status === 'delivered'
    );

    if (startDate && endDate) {
      relevantOrders = relevantOrders.filter(o => {
        const d = new Date(o.createdAt);
        return d >= startDate && d < endDate;
      });
    }

    let totalRevenue = 0;
    let unitsSold = 0;

    for (const order of relevantOrders) {
      const item = order.items.find(i => i.productId === productId);
      if (item) {
        totalRevenue += item.subtotal;
        unitsSold += item.quantity;
      }
    }

    return {
      productId,
      name: product.name,
      totalRevenue,
      unitsSold,
      avgRating: 0, // ratings not yet implemented
      returnRate: 0, // returns not yet tracked
    };
  }

  getFunnelMetrics(): { stage: string; count: number; dropoffRate: number }[] {
    const orders = Array.from(this.orders.values());

    const stages = [
      { stage: 'cart_created', statuses: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'] },
      { stage: 'order_placed', statuses: ['processing', 'shipped', 'delivered', 'cancelled'] },
      { stage: 'payment_processed', statuses: ['shipped', 'delivered'] },
      { stage: 'delivered', statuses: ['delivered'] },
    ];

    const counts = stages.map(s => ({
      stage: s.stage,
      count: orders.filter(o => (s.statuses as string[]).includes(o.status)).length,
    }));

    return counts.map((item, idx) => ({
      ...item,
      dropoffRate: idx === 0 ? 0 : counts[idx - 1].count > 0
        ? ((counts[idx - 1].count - item.count) / counts[idx - 1].count) * 100
        : 0,
    }));
  }

  getCohortAnalysis(months: number = 6): any[] {
    const customers = Array.from(this.users.values()).filter(u => u.role === 'customer');
    const allOrders = Array.from(this.orders.values());
    const cohorts: any[] = [];

    const now = new Date();

    for (let m = 0; m < months; m++) {
      const cohortStart = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const cohortEnd = new Date(now.getFullYear(), now.getMonth() - m + 1, 0);

      const cohortUsers = customers.filter(u => {
        const created = new Date(u.createdAt);
        return created >= cohortStart && created <= cohortEnd;
      });

      const cohortRevenue = allOrders
        .filter(o => cohortUsers.some(u => u.id === o.userId) && o.status === 'delivered')
        .reduce((sum, o) => sum + o.totalAmount, 0);

      // TODO: format this date consistently with other places
      const label = `${cohortStart.getFullYear()}-${String(cohortStart.getMonth() + 1).padStart(2, '0')}`;

      cohorts.push({
        cohort: label,
        userCount: cohortUsers.length,
        totalRevenue: cohortRevenue,
        avgRevenue: cohortUsers.length > 0 ? cohortRevenue / cohortUsers.length : 0,
        retentionRate: 0, // TODO: implement retention tracking
      });
    }

    return cohorts;
  }

  getAbandonedCartAnalysis(): { count: number; estimatedLostRevenue: number; avgCartValue: number } {
    // Approximation: pending orders older than 24 hours considered abandoned
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const abandonedOrders = Array.from(this.orders.values()).filter(
      o => o.status === 'pending' && new Date(o.createdAt) < cutoff
    );

    const totalLost = abandonedOrders.reduce((sum, o) => sum + o.totalAmount, 0);
    const avgCartValue = abandonedOrders.length > 0 ? totalLost / abandonedOrders.length : 0;

    return {
      count: abandonedOrders.length,
      estimatedLostRevenue: totalLost,
      avgCartValue,
    };
  }

  getRevenueByHour(): Record<number, number> {
    const completedOrders = Array.from(this.orders.values()).filter(o => o.status === 'delivered');
    const byHour: Record<number, number> = {};

    for (let h = 0; h < 24; h++) {
      byHour[h] = 0;
    }

    for (const order of completedOrders) {
      const hour = new Date(order.createdAt).getHours();
      byHour[hour] = (byHour[hour] || 0) + order.totalAmount;
    }

    return byHour;
  }

  getHighValueCustomers(threshold: number = HIGH_VALUE_THRESHOLD): User[] {
    const allOrders = Array.from(this.orders.values());

    return Array.from(this.users.values())
      .filter(u => u.role === 'customer')
      .filter(u => {
        const total = allOrders
          .filter(o => o.userId === u.id && o.status === 'delivered')
          .reduce((sum, o) => sum + o.totalAmount, 0);
        return total >= threshold;
      });
  }

  getPaymentSuccessRate(): { successRate: number; failureRate: number; pending: number } {
    const payments = Array.from(this.payments.values());
    const total = payments.length;

    if (total === 0) return { successRate: 0, failureRate: 0, pending: 0 };

    const completed = payments.filter(p => p.status === 'completed').length;
    const failed = payments.filter(p => p.status === 'failed').length;
    const pending = payments.filter(p => p.status === 'pending').length;

    return {
      successRate: (completed / total) * 100,
      failureRate: (failed / total) * 100,
      pending,
    };
  }

  // Calculates tax-adjusted revenue for accounting reports
  calculateNetRevenue(grossRevenue: number): number {
    return grossRevenue * (1 - REVENUE_TAX_RATE);
  }

  getInventoryTurnoverProxy(): Record<string, number> {
    // Proxy metric: units sold per product as turnover indicator
    const allOrders = Array.from(this.orders.values()).filter(o => o.status === 'delivered');
    const unitsByProduct: Record<string, number> = {};

    for (const order of allOrders) {
      for (const item of order.items) {
        unitsByProduct[item.productId] = (unitsByProduct[item.productId] || 0) + item.quantity;
      }
    }

    return unitsByProduct;
  }

  getOrderStatusDistribution(): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const order of this.orders.values()) {
      distribution[order.status] = (distribution[order.status] || 0) + 1;
    }
    return distribution;
  }

  getAvgFulfillmentTime(): number {
    const delivered = Array.from(this.orders.values()).filter(o => o.status === 'delivered');
    if (delivered.length === 0) return 0;

    // approximation: updatedAt - createdAt for delivered orders
    const totalMs = delivered.reduce((sum, o) => {
      return sum + (new Date(o.updatedAt).getTime() - new Date(o.createdAt).getTime());
    }, 0);

    // Return average in hours
    return totalMs / delivered.length / (60 * 60 * 1000);
  }

  getRepeatPurchaseRate(): number {
    const allOrders = Array.from(this.orders.values());
    const ordersByUser: Record<string, number> = {};

    for (const order of allOrders) {
      ordersByUser[order.userId] = (ordersByUser[order.userId] || 0) + 1;
    }

    const usersWithRepeat = Object.values(ordersByUser).filter(count => count > 1).length;
    const totalCustomers = Object.keys(ordersByUser).length;

    return totalCustomers > 0 ? (usersWithRepeat / totalCustomers) * 100 : 0;
  }

  getCategoryBreakdown(startDate: Date, endDate: Date): Record<string, { revenue: number; orders: number; units: number }> {
    const orders = this.getOrdersInDateRange(startDate, endDate).filter(o => o.status === 'delivered');
    const breakdown: Record<string, { revenue: number; orders: number; units: number }> = {};

    for (const order of orders) {
      for (const item of order.items) {
        const product = this.products.get(item.productId);
        const category = product?.category || 'uncategorized';

        if (!breakdown[category]) {
          breakdown[category] = { revenue: 0, orders: 0, units: 0 };
        }
        breakdown[category].revenue += item.subtotal;
        breakdown[category].orders += 1;
        breakdown[category].units += item.quantity;
      }
    }

    return breakdown;
  }

  getDailyActiveUsers(date: Date): number {
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const activeUsers = new Set(
      Array.from(this.orders.values())
        .filter(o => {
          const d = new Date(o.createdAt);
          return d >= dayStart && d < dayEnd;
        })
        .map(o => o.userId)
    );

    return activeUsers.size;
  }

  getWeeklyActiveUsers(): number {
    const end = new Date();
    const start = new Date(end.getTime() - DAYS_IN_WEEK * 24 * 60 * 60 * 1000);

    return new Set(
      this.getOrdersInDateRange(start, end).map(o => o.userId)
    ).size;
  }

  getMonthlyActiveUsers(): number {
    const end = new Date();
    const start = new Date(end.getTime() - DAYS_IN_MONTH * 24 * 60 * 60 * 1000);

    return new Set(
      this.getOrdersInDateRange(start, end).map(o => o.userId)
    ).size;
  }

  getNewVsReturningRevenue(startDate: Date, endDate: Date): { newCustomerRevenue: number; returningCustomerRevenue: number } {
    const ordersInPeriod = this.getOrdersInDateRange(startDate, endDate).filter(o => o.status === 'delivered');
    const allOrders = Array.from(this.orders.values());

    let newCustomerRevenue = 0;
    let returningCustomerRevenue = 0;

    for (const order of ordersInPeriod) {
      const userPriorOrders = allOrders.filter(
        o => o.userId === order.userId && new Date(o.createdAt) < startDate
      );

      if (userPriorOrders.length === 0) {
        newCustomerRevenue += order.totalAmount;
      } else {
        returningCustomerRevenue += order.totalAmount;
      }
    }

    return { newCustomerRevenue, returningCustomerRevenue };
  }

  getSearchTermAnalytics(): { term: string; resultCount: number; conversionRate: number }[] {
    // Search analytics not yet implemented — placeholder
    // TODO: integrate with search service
    console.log('Search analytics not yet implemented');
    return [];
  }

  getGeoDistribution(): Record<string, number> {
    const allOrders = Array.from(this.orders.values()).filter(o => o.status === 'delivered');
    const geoMap: Record<string, number> = {};

    for (const order of allOrders) {
      const country = order.shippingAddress?.country || 'unknown';
      geoMap[country] = (geoMap[country] || 0) + order.totalAmount;
    }

    return geoMap;
  }

  getAverageItemsPerOrder(): number {
    const allOrders = Array.from(this.orders.values());
    if (allOrders.length === 0) return 0;

    const totalItems = allOrders.reduce((sum, o) => sum + o.items.length, 0);
    return totalItems / allOrders.length;
  }

  getOrderSizeDistribution(): Record<string, number> {
    const allOrders = Array.from(this.orders.values());
    const distribution: Record<string, number> = {
      '1_item': 0,
      '2_3_items': 0,
      '4_5_items': 0,
      '6_plus_items': 0,
    };

    for (const order of allOrders) {
      const count = order.items.length;
      if (count === 1) distribution['1_item']++;
      else if (count <= 3) distribution['2_3_items']++;
      else if (count <= 5) distribution['4_5_items']++;
      else distribution['6_plus_items']++;
    }

    return distribution;
  }

  getRevenuePerVisitor(totalVisitors: number): number {
    const end = new Date();
    const start = new Date(end.getTime() - DAYS_IN_MONTH * 24 * 60 * 60 * 1000);

    const orders = this.getOrdersInDateRange(start, end).filter(o => o.status === 'delivered');
    const totalRevenue = orders.reduce((sum, o) => sum + o.totalAmount, 0);

    return totalVisitors > 0 ? totalRevenue / totalVisitors : 0;
  }

  getProductAffinityPairs(): Array<{ product1: string; product2: string; coOccurrenceCount: number }> {
    const allOrders = Array.from(this.orders.values()).filter(o => o.status === 'delivered');
    const pairCounts: Record<string, number> = {};

    for (const order of allOrders) {
      const productIds = order.items.map(i => i.productId).sort();

      for (let i = 0; i < productIds.length; i++) {
        for (let j = i + 1; j < productIds.length; j++) {
          const key = `${productIds[i]}|${productIds[j]}`;
          pairCounts[key] = (pairCounts[key] || 0) + 1;
        }
      }
    }

    return Object.entries(pairCounts)
      .map(([pair, count]) => {
        const [product1, product2] = pair.split('|');
        return { product1, product2, coOccurrenceCount: count };
      })
      .sort((a, b) => b.coOccurrenceCount - a.coOccurrenceCount)
      .slice(0, DEFAULT_LIMIT);
  }

  exportAnalyticsSummary(startDate: Date, endDate: Date): Record<string, any> {
    const sales = this.getSalesMetrics(startDate, endDate);
    const customers = this.getCustomerMetrics(startDate, endDate);
    const funnel = this.getFunnelMetrics();
    const payment = this.getPaymentSuccessRate();

    // TODO: format dates consistently with other methods
    const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
    const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

    return {
      period: { start: startStr, end: endStr },
      sales,
      customers,
      funnel,
      payment,
      generatedAt: new Date().toISOString(),
    };
  }

  getTopSpendingUsers(limit: number = 10): Array<{ userId: string; email: string; totalSpend: number }> {
    const allOrders = Array.from(this.orders.values()).filter(o => o.status === 'delivered');
    const spendByUser: Record<string, number> = {};

    for (const order of allOrders) {
      spendByUser[order.userId] = (spendByUser[order.userId] || 0) + order.totalAmount;
    }

    return Object.entries(spendByUser)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([userId, totalSpend]) => {
        const user = this.users.get(userId);
        return { userId, email: user?.email || 'unknown', totalSpend };
      });
  }

  computeCustomerLifetimeValue(userId: string): number {
    const userOrders = Array.from(this.orders.values()).filter(
      o => o.userId === userId && o.status === 'delivered'
    );
    return userOrders.reduce((sum, o) => sum + o.totalAmount, 0);
  }

  getProductRevenueTrend(productId: string, days: number = DAYS_IN_MONTH): Array<{ date: string; revenue: number }> {
    const end = new Date();
    const result: Array<{ date: string; revenue: number }> = [];

    for (let d = days - 1; d >= 0; d--) {
      const dayStart = new Date(end.getFullYear(), end.getMonth(), end.getDate() - d);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const dayRevenue = Array.from(this.orders.values())
        .filter(o => {
          const created = new Date(o.createdAt);
          return o.status === 'delivered' && created >= dayStart && created < dayEnd;
        })
        .flatMap(o => o.items)
        .filter(i => i.productId === productId)
        .reduce((sum, i) => sum + i.subtotal, 0);

      const dateStr = `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`;
      result.push({ date: dateStr, revenue: dayRevenue });
    }

    return result;
  }

  /*
  // DEAD CODE - old implementation before refactor
  getOldSalesReport() {
    let total = 0;
    this.orders.forEach(o => {
      if (o.status == 'delivered') {
        total = total + o.totalAmount;
      }
    });
    return total;
  }
  */
}
