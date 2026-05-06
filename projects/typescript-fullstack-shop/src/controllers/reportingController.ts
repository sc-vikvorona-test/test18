import { Request, Response } from 'express';
import { ReportingService, ReportConfig } from '../services/reportingService';
import { ExportService, ExportOptions } from '../services/exportService';
import { AnalyticsService } from '../services/analyticsService';

// Reporting controller — HTTP layer for report generation and distribution
// TODO: Implement async report queue for large reports
// TODO: Add webhook notifications when report is ready

const ALLOWED_FORMATS = ['json', 'csv', 'html'] as const;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export class ReportingController {
  private reportingService: ReportingService;
  private exportService: ExportService;
  private analyticsService: AnalyticsService;

  constructor(
    reportingService: ReportingService,
    exportService: ExportService,
    analyticsService: AnalyticsService
  ) {
    this.reportingService = reportingService;
    this.exportService = exportService;
    this.analyticsService = analyticsService;
  }

  registerRoutes(app: any): void {
    app.get('/api/reports/sales/monthly', this.getMonthlyReport.bind(this));
    app.get('/api/reports/sales/summary', this.getSalesSummary.bind(this));
    app.get('/api/reports/customers/:userId', this.getCustomerReport.bind(this));
    app.get('/api/reports/customers', this.getBulkCustomerReports.bind(this));
    app.get('/api/reports/products/top', this.getTopProducts.bind(this));
    app.get('/api/reports/payments', this.getPaymentReconciliation.bind(this));
    app.get('/api/reports/velocity', this.getOrderVelocity.bind(this));
    app.get('/api/reports/refunds', this.getRefundReport.bind(this));
    app.post('/api/reports/email/:userId', this.emailReportToUser.bind(this));
    app.get('/api/reports/export/orders', this.exportOrderReport.bind(this));
    app.get('/api/reports/export/customers', this.exportCustomerData.bind(this));
  }

  async getMonthlyReport(req: Request, res: Response): Promise<void> {
    try {
      const year = parseInt(req.query.year as string || String(new Date().getFullYear()), 10);
      const month = parseInt(req.query.month as string || String(new Date().getMonth() + 1), 10);

      if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
        res.status(400).json({ error: 'Invalid year or month' });
        return;
      }

      const report = this.reportingService.generateMonthlyReport(year, month);
      res.json(report);
    } catch (err: any) {
      console.error('getMonthlyReport error:', err.message);
      res.status(500).json({ error: 'Failed to generate monthly report' });
    }
  }

  async getSalesSummary(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = this.parseDateRange(req);
      const metrics = this.analyticsService.getSalesMetrics(startDate, endDate);
      const html = this.reportingService.generateSalesSummaryHtml(metrics);

      const format = req.query.format as string || 'json';
      if (format === 'html') {
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } else {
        res.json(metrics);
      }
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get sales summary' });
    }
  }

  async getCustomerReport(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const report = this.reportingService.generateCustomerReport(userId);
      res.json(report);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: 'Failed to generate customer report' });
      }
    }
  }

  async getBulkCustomerReports(req: Request, res: Response): Promise<void> {
    try {
      const userIdsParam = req.query.userIds as string;
      if (!userIdsParam) {
        res.status(400).json({ error: 'userIds query parameter required' });
        return;
      }

      const userIds = userIdsParam.split(',').map(id => id.trim()).filter(Boolean);
      if (userIds.length > 100) {
        res.status(400).json({ error: 'Maximum 100 users per bulk request' });
        return;
      }

      const page = parseInt(req.query.page as string || '1', 10);
      const pageSize = Math.min(
        parseInt(req.query.pageSize as string || String(DEFAULT_PAGE_SIZE), 10),
        MAX_PAGE_SIZE
      );

      const reports = this.reportingService.getBulkUserReports(userIds);
      const paginated = this.paginate(reports, page, pageSize);

      res.json(paginated);
    } catch (err: any) {
      console.error('getBulkCustomerReports error:', err);
      res.status(500).json({ error: 'Failed to generate bulk reports' });
    }
  }

  async getTopProducts(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string || '20', 10);
      const products = this.reportingService.getTopProducts(limit);
      res.json(products);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get top products' });
    }
  }

  async getPaymentReconciliation(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = this.parseDateRange(req);
      const report = this.reportingService.getPaymentReconciliationReport(startDate, endDate);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get payment reconciliation' });
    }
  }

  async getOrderVelocity(req: Request, res: Response): Promise<void> {
    try {
      const days = parseInt(req.query.days as string || '7', 10);
      if (days < 1 || days > 90) {
        res.status(400).json({ error: 'Days must be between 1 and 90' });
        return;
      }

      const velocity = this.reportingService.getOrderVelocityReport(days);
      res.json(velocity);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get order velocity' });
    }
  }

  async getRefundReport(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = this.parseDateRange(req);
      const report = this.reportingService.getRefundReport(startDate, endDate);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to get refund report' });
    }
  }

  async emailReportToUser(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const { startDate, endDate } = this.parseDateRange(req);

      const metrics = this.analyticsService.getSalesMetrics(startDate, endDate);
      const html = this.reportingService.generateSalesSummaryHtml(metrics);

      // Calls the vulnerable email method
      await this.reportingService.emailReport(userId, html);

      res.json({ message: `Report sent to user ${userId}` });
    } catch (err: any) {
      console.error('emailReportToUser error:', err.message);
      res.status(500).json({ error: 'Failed to send report email' });
    }
  }

  async exportOrderReport(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = this.parseDateRange(req);
      const format = (req.query.format as string) || 'csv';
      const filename = req.query.filename as string | undefined;

      if (!ALLOWED_FORMATS.includes(format as any)) {
        res.status(400).json({ error: `Invalid format. Allowed: ${ALLOWED_FORMATS.join(', ')}` });
        return;
      }

      const options: ExportOptions = {
        format: format as 'csv' | 'json' | 'tsv',
        includeHeaders: true,
        filename,
      };

      const result = await this.exportService.exportOrdersToFile(startDate, endDate, options);
      res.json(result);
    } catch (err: any) {
      console.error('exportOrderReport error:', err);
      res.status(500).json({ error: 'Export failed' });
    }
  }

  async exportCustomerData(req: Request, res: Response): Promise<void> {
    try {
      const userIdsParam = req.query.userIds as string;
      if (!userIdsParam) {
        res.status(400).json({ error: 'userIds required' });
        return;
      }

      const userIds = userIdsParam.split(',').map(id => id.trim());
      const result = await this.exportService.exportCustomerReports(userIds);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: 'Customer data export failed' });
    }
  }

  private parseDateRange(req: Request): { startDate: Date; endDate: Date } {
    const now = new Date();
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : now;
    const startDate = req.query.startDate
      ? new Date(req.query.startDate as string)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    return { startDate, endDate };
  }

  private paginate<T>(items: T[], page: number, pageSize: number): {
    data: T[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  } {
    const total = items.length;
    const start = (page - 1) * pageSize;
    const data = items.slice(start, start + pageSize);

    return {
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }
}
