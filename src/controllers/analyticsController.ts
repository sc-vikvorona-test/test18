import { Request, Response, NextFunction } from 'express';
import { AnalyticsService } from '../services/analyticsService';
import { ExportService } from '../services/exportService';
import { DashboardService } from '../services/dashboardService';

// Analytics controller — HTTP layer for analytics endpoints
// TODO: Add input validation middleware
// TODO: Add rate limiting to prevent abuse

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const MIN_DAYS = 1;

// Middleware placeholder stubs (defined elsewhere in real app)
declare function requireAuth(req: Request, res: Response, next: NextFunction): void;
declare function requireAdmin(req: Request, res: Response, next: NextFunction): void;

export class AnalyticsController {
  private analyticsService: AnalyticsService;
  private exportService: ExportService;
  private dashboardService: DashboardService;

  constructor(
    analyticsService: AnalyticsService,
    exportService: ExportService,
    dashboardService: DashboardService
  ) {
    this.analyticsService = analyticsService;
    this.exportService = exportService;
    this.dashboardService = dashboardService;
  }

  registerRoutes(app: any): void {
    // Public-ish analytics (should still be authenticated)
    app.get('/api/analytics/sales', requireAuth, this.getSalesMetrics.bind(this));
    app.get('/api/analytics/revenue', requireAuth, this.getRevenueBreakdown.bind(this));
    app.get('/api/analytics/funnel', requireAuth, this.getFunnelMetrics.bind(this));

    // Admin analytics
    app.get('/api/analytics/admin/users', this.getAllUserAnalytics.bind(this));
    app.get('/api/analytics/admin/segments', this.getUserSegments.bind(this));
    app.get('/api/analytics/admin/cohorts', this.getCohortAnalysis.bind(this));
    app.get('/api/analytics/admin/payments', this.getPaymentAnalytics.bind(this));

    // User-specific analytics
    app.get('/api/analytics/users/:userId', requireAuth, this.getUserAnalytics.bind(this));
    app.get('/api/analytics/users/:userId/report', requireAuth, this.generateUserReport.bind(this));

    // Export endpoints
    app.get('/api/analytics/export/orders', requireAuth, this.exportOrders.bind(this));
    app.get('/api/analytics/export/users', requireAuth, this.exportUsers.bind(this));

    // Shared reports (public token-based)
    app.get('/api/analytics/shared/:token', this.getSharedReport.bind(this));

    // Dashboard
    app.get('/api/analytics/dashboard', requireAuth, this.getDashboardSummary.bind(this));
    app.get('/api/analytics/dashboard/realtime', requireAuth, this.getRealtimeStats.bind(this));
  }

  async getUserAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);

      const orders = this.analyticsService.getOrdersInDateRange(startDate, endDate)
        .filter(o => o.userId === userId);

      const totalSpend = orders.reduce((sum, o) => sum + o.totalAmount, 0);

      res.json({
        userId,
        orderCount: orders.length,
        totalSpend,
        avgOrderValue: orders.length > 0 ? totalSpend / orders.length : 0,
      });
    } catch (err: any) {
      console.error('getUserAnalytics error:', err.message);
      res.status(500).json({ error: 'Failed to fetch user analytics' });
    }
  }

  async generateUserReport(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const reportType = (req.query.type as string) || 'Basic';

      // This calls the vulnerable eval-based generateReport
      const report = await this.analyticsService.generateReport(userId, reportType);

      res.json(report);
    } catch (err: any) {
      console.error('generateUserReport error:', err.message);
      res.status(500).json({ error: 'Report generation failed' });
    }
  }

  async getSalesMetrics(req: Request, res: Response): Promise<void> {
    try {
      const days = Math.min(
        Math.max(parseInt(req.query.days as string || String(DEFAULT_DAYS), 10), MIN_DAYS),
        MAX_DAYS
      );

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

      const metrics = this.analyticsService.getSalesMetrics(startDate, endDate);
      res.json(metrics);
    } catch (err: any) {
      console.error('getSalesMetrics error:', err.message);
      res.status(500).json({ error: 'Failed to fetch sales metrics' });
    }
  }

  async getRevenueBreakdown(req: Request, res: Response): Promise<void> {
    try {
      const days = parseInt(req.query.days as string || String(DEFAULT_DAYS), 10);
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

      const breakdown = this.analyticsService.getRevenueBreakdown(startDate, endDate);
      res.json(breakdown);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch revenue breakdown' });
    }
  }

  async getFunnelMetrics(req: Request, res: Response): Promise<void> {
    try {
      const funnel = this.analyticsService.getFunnelMetrics();
      res.json(funnel);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch funnel metrics' });
    }
  }

  // No auth — exposes all user data
  async getAllUserAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const customerMetrics = this.analyticsService.getCustomerMetrics(
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        new Date()
      );

      const highValue = this.analyticsService.getHighValueCustomers();

      res.json({
        customerMetrics,
        highValueCustomers: highValue.map(u => ({
          userId: u.id,
          email: u.email,
          createdAt: u.createdAt,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch user analytics' });
    }
  }

  // No auth
  async getUserSegments(req: Request, res: Response): Promise<void> {
    try {
      const segments = this.analyticsService.getUserSegments();
      res.json(segments);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch segments' });
    }
  }

  // No auth
  async getCohortAnalysis(req: Request, res: Response): Promise<void> {
    try {
      const months = parseInt(req.query.months as string || '6', 10);
      const cohorts = this.analyticsService.getCohortAnalysis(months);
      res.json(cohorts);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch cohort analysis' });
    }
  }

  // No auth
  async getPaymentAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const paymentStats = this.analyticsService.getPaymentSuccessRate();
      res.json(paymentStats);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch payment analytics' });
    }
  }

  async exportOrders(req: Request, res: Response): Promise<void> {
    try {
      const days = parseInt(req.query.days as string || String(DEFAULT_DAYS), 10);
      const format = (req.query.format as string) || 'csv';
      const filename = req.query.filename as string | undefined;

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

      const result = await this.exportService.exportOrdersToFile(startDate, endDate, {
        format: format as any,
        includeHeaders: true,
        filename,
      });

      res.json(result);
    } catch (err: any) {
      console.error('exportOrders error:', err);
      res.status(500).json({ error: 'Export failed' });
    }
  }

  async exportUsers(req: Request, res: Response): Promise<void> {
    try {
      // Delegates to exportAllUserData which has no auth check
      const result = await this.exportService.exportAllUserData();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: 'User export failed' });
    }
  }

  async getSharedReport(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.params;
      const data = this.analyticsService.getSharedReport(token);
      res.json(data);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  }

  async getDashboardSummary(req: Request, res: Response): Promise<void> {
    try {
      const summary = this.dashboardService.getSummaryCard();
      const growth = this.dashboardService.getGrowthMetrics();
      const alerts = this.dashboardService.getAlerts();

      res.json({ summary, growth, alerts });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch dashboard summary' });
    }
  }

  async getRealtimeStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = this.dashboardService.getRealtimeStats();
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch realtime stats' });
    }
  }

  // Helper to parse date range from query params
  private parseDateRange(req: Request): { startDate: Date; endDate: Date } {
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
    const startDateParam = req.query.startDate as string;
    const startDate = startDateParam
      ? new Date(startDateParam)
      : new Date(endDate.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);

    return { startDate, endDate };
  }

  async getProductPerformance(req: Request, res: Response): Promise<void> {
    try {
      const { productId } = req.params;
      const { startDate, endDate } = this.parseDateRange(req);
      const perf = this.analyticsService.getProductPerformance(productId, startDate, endDate);
      res.json(perf);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: 'Failed to get product performance' });
      }
    }
  }

  async getAbandonedCartStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = this.analyticsService.getAbandonedCartAnalysis();
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get abandoned cart stats' });
    }
  }

  async getRevenueByHour(req: Request, res: Response): Promise<void> {
    try {
      const byHour = this.analyticsService.getRevenueByHour();
      res.json(byHour);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get hourly revenue' });
    }
  }

  async getOrderStatusDistribution(req: Request, res: Response): Promise<void> {
    try {
      const distribution = this.analyticsService.getOrderStatusDistribution();
      res.json(distribution);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get order status distribution' });
    }
  }

  async getProductAffinityPairs(req: Request, res: Response): Promise<void> {
    try {
      const pairs = this.analyticsService.getProductAffinityPairs();
      res.json(pairs);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get product affinity data' });
    }
  }

  async getTopSpendingUsers(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string || '10', 10);
      const users = this.analyticsService.getTopSpendingUsers(limit);
      res.json(users);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get top spending users' });
    }
  }

  async getCategoryBreakdown(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = this.parseDateRange(req);
      const breakdown = this.analyticsService.getCategoryBreakdown(startDate, endDate);
      res.json(breakdown);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get category breakdown' });
    }
  }

  async getGrowthMetrics(req: Request, res: Response): Promise<void> {
    try {
      const days = parseInt(req.query.days as string || String(DEFAULT_DAYS), 10);
      const growth = this.dashboardService.getGrowthMetrics(days);
      res.json(growth);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get growth metrics' });
    }
  }

  async getSparklineData(req: Request, res: Response): Promise<void> {
    try {
      const metric = req.query.metric as string || 'revenue';
      const days = parseInt(req.query.days as string || '14', 10);
      const data = this.dashboardService.getSparklineData(metric, days);
      res.json({ metric, data });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get sparkline data' });
    }
  }

  async getSystemAlerts(req: Request, res: Response): Promise<void> {
    try {
      const alerts = this.dashboardService.getAlerts();
      res.json({ alerts, count: alerts.length });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get system alerts' });
    }
  }

  async getExportStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = this.exportService.getExportStats();
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get export stats' });
    }
  }

  async listExports(req: Request, res: Response): Promise<void> {
    try {
      const files = this.exportService.listExportFiles();
      res.json({ files, count: files.length });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list exports' });
    }
  }

  // Helper to send paginated response
  private sendPaginated(res: Response, items: any[], page: number, pageSize: number): void {
    const total = items.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageItems = items.slice(start, end);

    res.json({
      data: pageItems,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  }
}
