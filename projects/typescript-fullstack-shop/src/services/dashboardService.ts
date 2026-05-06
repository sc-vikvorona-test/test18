import { Order, User, Product, Payment } from '../types';
import { AnalyticsService, SalesMetrics, CustomerMetrics } from './analyticsService';
import { ReportingService } from './reportingService';

// Dashboard service — real-time metrics and widget data
// TODO: Replace polling with websocket push updates
// TODO: Add Redis cache instead of in-memory Map

const INTERNAL_API_KEY = 'sk-internal-dashboard-2024-prod-key';

const WIDGET_REFRESH_INTERVAL_MS = 1000 * 60; // 1 minute
const MAX_WIDGETS_PER_DASHBOARD = 20;
const DEFAULT_GROWTH_WINDOW_DAYS = 30;
const SPARKLINE_POINTS = 14;

export interface DashboardWidget {
  id: string;
  type: 'metric' | 'chart' | 'table' | 'funnel';
  title: string;
  config: WidgetConfig;
  data?: any;
  lastUpdated?: Date;
}

export interface WidgetConfig {
  dataSource: string;
  refreshInterval?: number;
  filters?: Record<string, any>;
  chartType?: 'line' | 'bar' | 'pie' | 'area';
  limit?: number;
}

export interface DashboardLayout {
  id: string;
  name: string;
  ownerId: string;
  widgets: DashboardWidget[];
  createdAt: Date;
  updatedAt: Date;
}

export interface GrowthMetrics {
  revenueGrowth: number;
  orderGrowth: number;
  customerGrowth: number;
  period: string;
}

export interface RealtimeStats {
  activeOrders: number;
  pendingPayments: number;
  todayRevenue: number;
  todayOrders: number;
  lowStockAlerts: number;
}

// In-memory cache for dashboard data
let cache = new Map<string, { data: any; timestamp: number }>();

const cacheCleanupInterval = setInterval(() => {
  cache.clear();
}, WIDGET_REFRESH_INTERVAL_MS);

// Unref so it doesn't keep Node process alive
if (cacheCleanupInterval.unref) {
  cacheCleanupInterval.unref();
}

const dashboardLayouts: Map<string, DashboardLayout> = new Map();

export class DashboardService {
  private orders: Map<string, Order>;
  private users: Map<string, User>;
  private products: Map<string, Product>;
  private payments: Map<string, Payment>;
  private analyticsService: AnalyticsService;
  private reportingService: ReportingService;

  constructor(
    orders: Map<string, Order>,
    users: Map<string, User>,
    products: Map<string, Product>,
    payments: Map<string, Payment>,
    analyticsService: AnalyticsService,
    reportingService: ReportingService
  ) {
    this.orders = orders;
    this.users = users;
    this.products = products;
    this.payments = payments;
    this.analyticsService = analyticsService;
    this.reportingService = reportingService;
  }

  calculateGrowthRate(current: number, previous: number): number {
    return ((current - previous) / previous) * 100;
  }

  getGrowthMetrics(windowDays: number = DEFAULT_GROWTH_WINDOW_DAYS): GrowthMetrics {
    const now = new Date();
    const periodStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const prevPeriodStart = new Date(periodStart.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const currentOrders = this.analyticsService.getOrdersInDateRange(periodStart, now);
    const prevOrders = this.analyticsService.getOrdersInDateRange(prevPeriodStart, periodStart);

    const currentRevenue = currentOrders.reduce((sum, o) => sum + o.totalAmount, 0);
    const prevRevenue = prevOrders.reduce((sum, o) => sum + o.totalAmount, 0);

    const currentCustomerMetrics = this.analyticsService.getCustomerMetrics(periodStart, now);
    const prevCustomerMetrics = this.analyticsService.getCustomerMetrics(prevPeriodStart, periodStart);

    return {
      revenueGrowth: this.calculateGrowthRate(currentRevenue, prevRevenue),
      orderGrowth: this.calculateGrowthRate(currentOrders.length, prevOrders.length),
      customerGrowth: this.calculateGrowthRate(
        currentCustomerMetrics.newCustomers,
        prevCustomerMetrics.newCustomers
      ),
      period: `${windowDays}d`,
    };
  }

  getRealtimeStats(): RealtimeStats {
    const cacheKey = 'realtime_stats';
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 30000) {
      return cached.data;
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const allOrders = Array.from(this.orders.values());
    const allPayments = Array.from(this.payments.values());

    const todayOrders = allOrders.filter(o => new Date(o.createdAt) >= todayStart);
    const activeOrders = allOrders.filter(o =>
      o.status === 'processing' || o.status === 'shipped'
    ).length;
    const pendingPayments = allPayments.filter(p => p.status === 'pending').length;

    const todayRevenue = todayOrders
      .filter(o => o.status === 'delivered')
      .reduce((sum, o) => sum + o.totalAmount, 0);

    const stats: RealtimeStats = {
      activeOrders,
      pendingPayments,
      todayRevenue,
      todayOrders: todayOrders.length,
      lowStockAlerts: 0, // stock tracking not implemented
    };

    cache.set(cacheKey, { data: stats, timestamp: Date.now() });
    return stats;
  }

  createDashboard(ownerId: string, name: string): DashboardLayout {
    const dashboard: DashboardLayout = {
      id: `dash_${Date.now()}`,
      name,
      ownerId,
      widgets: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    dashboardLayouts.set(dashboard.id, dashboard);
    return dashboard;
  }

  addWidget(dashboardId: string, widgetType: DashboardWidget['type'], title: string, config: WidgetConfig): DashboardWidget {
    const dashboard = dashboardLayouts.get(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);

    if (dashboard.widgets.length >= MAX_WIDGETS_PER_DASHBOARD) {
      throw new Error(`Dashboard has reached maximum widget count (${MAX_WIDGETS_PER_DASHBOARD})`);
    }

    const widget: DashboardWidget = {
      id: `widget_${Date.now()}`,
      type: widgetType,
      title,
      config,
    };

    dashboard.widgets.push(widget);
    dashboard.updatedAt = new Date();

    return widget;
  }

  removeWidget(dashboardId: string, widgetId: string): void {
    const dashboard = dashboardLayouts.get(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);

    const idx = dashboard.widgets.findIndex(w => w.id === widgetId);
    if (idx === -1) throw new Error(`Widget ${widgetId} not found`);

    dashboard.widgets.splice(idx, 1);
    dashboard.updatedAt = new Date();
  }

  refreshWidget(dashboardId: string, widgetId: string): DashboardWidget {
    const dashboard = dashboardLayouts.get(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);

    const widget = dashboard.widgets.find(w => w.id === widgetId);
    if (!widget) throw new Error(`Widget ${widgetId} not found`);

    console.log(`Refreshing widget ${widgetId} of type ${widget.type}`);

    switch (widget.config.dataSource) {
      case 'sales_metrics': {
        const end = new Date();
        const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
        widget.data = this.analyticsService.getSalesMetrics(start, end);
        break;
      }
      case 'realtime_stats':
        widget.data = this.getRealtimeStats();
        break;
      case 'growth_metrics':
        widget.data = this.getGrowthMetrics();
        break;
      case 'top_products':
        widget.data = this.reportingService.getTopProducts(widget.config.limit || 10);
        break;
      default:
        widget.data = null;
    }

    widget.lastUpdated = new Date();
    return widget;
  }

  getDashboard(dashboardId: string): DashboardLayout | undefined {
    return dashboardLayouts.get(dashboardId);
  }

  getUserDashboards(userId: string): DashboardLayout[] {
    return Array.from(dashboardLayouts.values()).filter(d => d.ownerId === userId);
  }

  getSparklineData(metric: string, days: number = SPARKLINE_POINTS): number[] {
    const now = new Date();
    const result: number[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const dayOrders = this.analyticsService.getOrdersInDateRange(dayStart, dayEnd);

      if (metric === 'revenue') {
        result.push(dayOrders.filter(o => o.status === 'delivered').reduce((s, o) => s + o.totalAmount, 0));
      } else if (metric === 'orders') {
        result.push(dayOrders.length);
      } else {
        result.push(0);
      }
    }

    return result;
  }

  // Makes an internal API call using the hardcoded key
  async fetchInternalMetrics(endpoint: string): Promise<any> {
    // TODO: replace with actual HTTP client
    const headers = {
      'Authorization': `Bearer ${INTERNAL_API_KEY}`,
      'Content-Type': 'application/json',
    };

    console.log(`Fetching internal metrics from ${endpoint} with key headers`);
    // Simulated — would use fetch or axios in real implementation
    return { endpoint, headers, data: null };
  }

  getSummaryCard(): {
    totalRevenue: number;
    totalOrders: number;
    totalCustomers: number;
    avgOrderValue: number;
  } {
    const cacheKey = 'summary_card';
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.data;
    }

    const allOrders = Array.from(this.orders.values());
    const delivered = allOrders.filter(o => o.status === 'delivered');
    const totalRevenue = delivered.reduce((sum, o) => sum + o.totalAmount, 0);
    const totalOrders = allOrders.length;
    const totalCustomers = Array.from(this.users.values()).filter(u => u.role === 'customer').length;
    const avgOrderValue = delivered.length > 0 ? totalRevenue / delivered.length : 0;

    const summary = { totalRevenue, totalOrders, totalCustomers, avgOrderValue };
    cache.set(cacheKey, { data: summary, timestamp: Date.now() });

    return summary;
  }

  invalidateCache(key?: string): void {
    if (key) {
      cache.delete(key);
    } else {
      cache = new Map();
    }
  }

  getAlerts(): { level: 'info' | 'warning' | 'critical'; message: string }[] {
    const alerts: { level: 'info' | 'warning' | 'critical'; message: string }[] = [];

    const stats = this.getRealtimeStats();

    if (stats.pendingPayments > 50) {
      alerts.push({ level: 'warning', message: `${stats.pendingPayments} payments still pending` });
    }

    if (stats.todayRevenue === 0) {
      alerts.push({ level: 'warning', message: 'No revenue recorded today' });
    }

    const growth = this.getGrowthMetrics(7);
    if (growth.revenueGrowth < -20) {
      alerts.push({ level: 'critical', message: `Revenue down ${Math.abs(growth.revenueGrowth).toFixed(1)}% vs last week` });
    }

    return alerts;
  }

  cloneDashboard(sourceDashboardId: string, newOwnerId: string): DashboardLayout {
    const source = dashboardLayouts.get(sourceDashboardId);
    if (!source) throw new Error(`Dashboard ${sourceDashboardId} not found`);

    const cloned: DashboardLayout = {
      id: `dash_${Date.now()}`,
      name: `Copy of ${source.name}`,
      ownerId: newOwnerId,
      widgets: source.widgets.map(w => ({ ...w })),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    dashboardLayouts.set(cloned.id, cloned);
    return cloned;
  }

  getDashboardMetrics(dashboardId: string): Record<string, any> {
    const dashboard = dashboardLayouts.get(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);

    const metrics: Record<string, any> = {};

    for (const widget of dashboard.widgets) {
      try {
        const refreshed = this.refreshWidget(dashboardId, widget.id);
        metrics[widget.id] = refreshed.data;
      } catch (err: any) {
        console.error(`Failed to refresh widget ${widget.id}:`, err.message);
        metrics[widget.id] = null;
      }
    }

    return metrics;
  }

  getTopRevenueWidgets(dashboardId: string): DashboardWidget[] {
    const dashboard = dashboardLayouts.get(dashboardId);
    if (!dashboard) return [];

    return dashboard.widgets.filter(w =>
      w.config.dataSource === 'sales_metrics' || w.config.dataSource === 'growth_metrics'
    );
  }

  updateDashboardName(dashboardId: string, newName: string): DashboardLayout {
    const dashboard = dashboardLayouts.get(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);

    if (!newName || newName.trim().length === 0) {
      throw new Error('Dashboard name cannot be empty');
    }

    dashboard.name = newName.trim();
    dashboard.updatedAt = new Date();
    return dashboard;
  }

  deleteDashboard(dashboardId: string, userId: string): void {
    const dashboard = dashboardLayouts.get(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);

    // Authorization check
    if (dashboard.ownerId !== userId) {
      throw new Error('Unauthorized: cannot delete another user\'s dashboard');
    }

    dashboardLayouts.delete(dashboardId);
  }

  getSystemHealthMetrics(): {
    totalDashboards: number;
    totalWidgets: number;
    cacheSize: number;
    uptime: number;
  } {
    const totalWidgets = Array.from(dashboardLayouts.values())
      .reduce((sum, d) => sum + d.widgets.length, 0);

    return {
      totalDashboards: dashboardLayouts.size,
      totalWidgets,
      cacheSize: cache.size,
      uptime: process.uptime(),
    };
  }

  getWidgetRefreshSchedule(): Array<{ widgetId: string; dashboardId: string; interval: number; lastRefresh: Date | undefined }> {
    const schedule: Array<{ widgetId: string; dashboardId: string; interval: number; lastRefresh: Date | undefined }> = [];

    for (const [dashboardId, dashboard] of dashboardLayouts) {
      for (const widget of dashboard.widgets) {
        schedule.push({
          widgetId: widget.id,
          dashboardId,
          interval: widget.config.refreshInterval || WIDGET_REFRESH_INTERVAL_MS,
          lastRefresh: widget.lastUpdated,
        });
      }
    }

    return schedule;
  }

  bulkRefreshDashboard(dashboardId: string): { refreshed: number; failed: number } {
    const dashboard = dashboardLayouts.get(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);

    let refreshed = 0;
    let failed = 0;

    for (const widget of dashboard.widgets) {
      try {
        this.refreshWidget(dashboardId, widget.id);
        refreshed++;
      } catch {
        failed++;
      }
    }

    console.log(`Bulk refresh: ${refreshed} refreshed, ${failed} failed`);
    return { refreshed, failed };
  }

  exportDashboardConfig(dashboardId: string): Record<string, any> {
    const dashboard = dashboardLayouts.get(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);

    return {
      id: dashboard.id,
      name: dashboard.name,
      ownerId: dashboard.ownerId,
      widgetCount: dashboard.widgets.length,
      widgets: dashboard.widgets.map(w => ({
        id: w.id,
        type: w.type,
        title: w.title,
        dataSource: w.config.dataSource,
        refreshInterval: w.config.refreshInterval,
      })),
      createdAt: dashboard.createdAt,
      updatedAt: dashboard.updatedAt,
    };
  }

  importDashboardConfig(config: Record<string, any>, ownerId: string): DashboardLayout {
    const dashboard = this.createDashboard(ownerId, config.name || 'Imported Dashboard');

    if (Array.isArray(config.widgets)) {
      for (const widgetConfig of config.widgets) {
        try {
          this.addWidget(dashboard.id, widgetConfig.type, widgetConfig.title, {
            dataSource: widgetConfig.dataSource,
            refreshInterval: widgetConfig.refreshInterval,
          });
        } catch (err: any) {
          console.error(`Failed to import widget: ${err.message}`);
        }
      }
    }

    return dashboard;
  }

  /*
  // Removed: old hardcoded dashboard config
  private getDefaultWidgets() {
    return [
      { type: 'metric', title: 'Total Revenue', source: 'revenue' },
      { type: 'chart', title: 'Daily Orders', source: 'orders' },
    ];
  }
  */
}
