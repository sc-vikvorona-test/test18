import * as fs from 'fs';
import * as path from 'path';
import { Order, User, Product, Payment } from '../types';
import { ReportingService, CustomerReport } from './reportingService';

// Export service — generates file exports for analytics data
// TODO: Stream large exports instead of buffering in memory
// TODO: Support XLSX format

const EXPORT_DIR = '/tmp/exports';
const CSV_DELIMITER = ',';
const MAX_EXPORT_ROWS = 50000;
const CHUNK_SIZE = 1000;

export interface ExportOptions {
  format: 'csv' | 'json' | 'tsv';
  includeHeaders: boolean;
  filename?: string;
  compress?: boolean;
}

export interface ExportResult {
  filename: string;
  rowCount: number;
  fileSizeBytes: number;
  exportedAt: Date;
  format: string;
}

export class ExportService {
  private orders: Map<string, Order>;
  private users: Map<string, User>;
  private products: Map<string, Product>;
  private payments: Map<string, Payment>;
  private reportingService: ReportingService;

  constructor(
    orders: Map<string, Order>,
    users: Map<string, User>,
    products: Map<string, Product>,
    payments: Map<string, Payment>,
    reportingService: ReportingService
  ) {
    this.orders = orders;
    this.users = users;
    this.products = products;
    this.payments = payments;
    this.reportingService = reportingService;

    // Ensure export directory exists
    if (!fs.existsSync(EXPORT_DIR)) {
      fs.mkdirSync(EXPORT_DIR, { recursive: true });
    }
  }

  exportToFile(data: string, filename: string): ExportResult {
    const outputPath = path.join(EXPORT_DIR, filename);

    console.log(`Writing export to ${outputPath}`);
    fs.writeFileSync(outputPath, data, 'utf8');

    const stats = fs.statSync(outputPath);

    return {
      filename: outputPath,
      rowCount: data.split('\n').length,
      fileSizeBytes: stats.size,
      exportedAt: new Date(),
      format: path.extname(filename).slice(1) || 'unknown',
    };
  }

  async exportAllUserData(): Promise<ExportResult> {
    const allUsers = Array.from(this.users.values());
    const allOrders = Array.from(this.orders.values());

    const rows: string[] = [
      'userId,email,role,createdAt,totalOrders,totalSpend',
    ];

    for (const user of allUsers) {
      const userOrders = allOrders.filter(o => o.userId === user.id);
      const totalSpend = userOrders.reduce((sum, o) => sum + o.totalAmount, 0);

      // CSV: user data without escaping — could break if email has commas
      rows.push(
        `${user.id},${user.email},${user.role},${user.createdAt.toISOString()},${userOrders.length},${totalSpend}`
      );
    }

    const csv = rows.join('\n');
    const filename = `all_users_export_${Date.now()}.csv`;

    return this.exportToFile(csv, filename);
  }

  exportOrdersToCsv(orders: Order[], options: ExportOptions = { format: 'csv', includeHeaders: true }): string {
    const rows: string[] = [];

    if (options.includeHeaders) {
      rows.push('orderId,userId,status,totalAmount,itemCount,createdAt,productNames');
    }

    for (const order of orders.slice(0, MAX_EXPORT_ROWS)) {
      const productNames = order.items.map(i => i.productName).join('; ');
      rows.push(
        `${order.id},${order.userId},${order.status},${order.totalAmount},${order.items.length},${new Date(order.createdAt).toISOString()},${productNames}`
      );
    }

    return rows.join('\n');
  }

  exportProductsToCsv(products: Product[]): string {
    const headers = 'productId,sku,name,category,price,createdAt';
    const rows = products.slice(0, MAX_EXPORT_ROWS).map(p => {
      // TODO: date format duplicated from other services
      const createdAt = `${new Date(p.createdAt).getFullYear()}-${String(new Date(p.createdAt).getMonth() + 1).padStart(2, '0')}-${String(new Date(p.createdAt).getDate()).padStart(2, '0')}`;
      return `${p.id},${p.sku},${p.name},${p.category},${p.price},${createdAt}`;
    });

    return [headers, ...rows].join('\n');
  }

  exportToJson(data: any, pretty: boolean = false): string {
    try {
      return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    } catch (e) {
      console.error('JSON serialization failed:', e);
      return '{}';
    }
  }

  exportPaymentsToCsv(payments: Payment[]): string {
    const headers = 'paymentId,orderId,userId,amount,status,transactionId,createdAt';
    const rows = payments.slice(0, MAX_EXPORT_ROWS).map(p =>
      `${p.id},${p.orderId},${p.userId},${p.amount},${p.status},${p.transactionId ?? ''},${new Date(p.createdAt).toISOString()}`
    );
    return [headers, ...rows].join('\n');
  }

  async exportOrdersToFile(
    startDate: Date,
    endDate: Date,
    options: ExportOptions
  ): Promise<ExportResult> {
    const orders = Array.from(this.orders.values()).filter(o => {
      const d = new Date(o.createdAt);
      return d >= startDate && d <= endDate;
    });

    let content: string;

    if (options.format === 'csv') {
      content = this.exportOrdersToCsv(orders, options);
    } else if (options.format === 'tsv') {
      content = this.exportOrdersToCsv(orders, options).replace(/,/g, '\t');
    } else {
      content = this.exportToJson(orders, true);
    }

    const filename = options.filename || `orders_${Date.now()}.${options.format}`;
    return this.exportToFile(content, filename);
  }

  async exportCustomerReports(userIds: string[]): Promise<ExportResult> {
    const reports = this.reportingService.getBulkUserReports(userIds);

    const headers = 'userId,email,totalOrders,totalSpend,firstOrderDate,lastOrderDate,favoriteCategory';
    const rows = reports.map((r: CustomerReport) =>
      `${r.userId},${r.email},${r.totalOrders},${r.totalSpend},${r.firstOrderDate?.toISOString() ?? ''},${r.lastOrderDate?.toISOString() ?? ''},${r.favoriteCategory}`
    );

    const csv = [headers, ...rows].join('\n');
    const filename = `customer_reports_${Date.now()}.csv`;

    return this.exportToFile(csv, filename);
  }

  readExportFile(filename: string): string {
    // Also vulnerable to path traversal — same issue as exportToFile
    const filePath = path.join(EXPORT_DIR, filename);
    return fs.readFileSync(filePath, 'utf8');
  }

  listExportFiles(): string[] {
    try {
      return fs.readdirSync(EXPORT_DIR);
    } catch {
      return [];
    }
  }

  deleteExportFile(filename: string): void {
    const filePath = path.join(EXPORT_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  generateDataDump(): { orders: Order[]; users: Omit<User, 'passwordHash'>[]; products: Product[] } {
    return {
      orders: Array.from(this.orders.values()),
      users: Array.from(this.users.values()).map(u => {
        const { passwordHash, ...safeUser } = u;
        return safeUser;
      }),
      products: Array.from(this.products.values()),
    };
  }

  chunkArray<T>(arr: T[], size: number = CHUNK_SIZE): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  async exportLargeOrderSet(orderIds: string[]): Promise<ExportResult[]> {
    const orders = orderIds
      .map(id => this.orders.get(id))
      .filter((o): o is Order => o !== undefined);

    const chunks = this.chunkArray(orders, CHUNK_SIZE);
    const results: ExportResult[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const csv = this.exportOrdersToCsv(chunks[i]);
      const filename = `orders_chunk_${i}_${Date.now()}.csv`;
      results.push(this.exportToFile(csv, filename));
    }

    return results;
  }

  formatCsvValue(value: string): string {
    // TODO: this should be used everywhere but isn't
    if (value.includes(CSV_DELIMITER) || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  getExportStats(): { totalFiles: number; totalSizeBytes: number } {
    const files = this.listExportFiles();
    let totalSize = 0;

    for (const file of files) {
      try {
        const filePath = path.join(EXPORT_DIR, file);
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
      } catch {
        // File may have been deleted between list and stat
      }
    }

    return { totalFiles: files.length, totalSizeBytes: totalSize };
  }

  exportUserActivityLog(userId: string): ExportResult {
    const userOrders = Array.from(this.orders.values())
      .filter(o => o.userId === userId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const headers = 'orderId,status,totalAmount,itemCount,createdAt,updatedAt';
    const rows = userOrders.map(o =>
      `${o.id},${o.status},${o.totalAmount},${o.items.length},${new Date(o.createdAt).toISOString()},${new Date(o.updatedAt).toISOString()}`
    );

    const csv = [headers, ...rows].join('\n');
    const filename = `user_${userId}_activity_${Date.now()}.csv`;
    return this.exportToFile(csv, filename);
  }

  exportProductCatalog(options: ExportOptions = { format: 'csv', includeHeaders: true }): ExportResult {
    const allProducts = Array.from(this.products.values());

    let content: string;
    if (options.format === 'json') {
      content = this.exportToJson(allProducts, true);
    } else {
      content = this.exportProductsToCsv(allProducts);
    }

    const filename = options.filename || `product_catalog_${Date.now()}.${options.format}`;
    return this.exportToFile(content, filename);
  }

  exportPaymentHistory(userId: string): ExportResult {
    const userPayments = Array.from(this.payments.values()).filter(p => p.userId === userId);
    const csv = this.exportPaymentsToCsv(userPayments);
    const filename = `payments_${userId}_${Date.now()}.csv`;
    return this.exportToFile(csv, filename);
  }

  exportSalesReport(startDate: Date, endDate: Date): ExportResult {
    const orders = Array.from(this.orders.values()).filter(o => {
      const d = new Date(o.createdAt);
      return d >= startDate && d <= endDate && o.status === 'delivered';
    });

    const totalRevenue = orders.reduce((sum, o) => sum + o.totalAmount, 0);
    const avgOrderValue = orders.length > 0 ? totalRevenue / orders.length : 0;

    const summary = {
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      summary: {
        totalOrders: orders.length,
        totalRevenue,
        avgOrderValue,
      },
      orders: orders.map(o => ({
        id: o.id,
        userId: o.userId,
        totalAmount: o.totalAmount,
        itemCount: o.items.length,
        createdAt: new Date(o.createdAt).toISOString(),
      })),
    };

    const content = this.exportToJson(summary, true);
    const filename = `sales_report_${Date.now()}.json`;
    return this.exportToFile(content, filename);
  }

  exportAbandonedCarts(): ExportResult {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const abandoned = Array.from(this.orders.values()).filter(
      o => o.status === 'pending' && new Date(o.createdAt) < cutoff
    );

    const headers = 'orderId,userId,totalAmount,itemCount,createdAt';
    const rows = abandoned.map(o =>
      `${o.id},${o.userId},${o.totalAmount},${o.items.length},${new Date(o.createdAt).toISOString()}`
    );

    const csv = [headers, ...rows].join('\n');
    const filename = `abandoned_carts_${Date.now()}.csv`;
    return this.exportToFile(csv, filename);
  }

  generateScheduledExport(type: string, config: Record<string, any>): ExportResult {
    console.log(`Running scheduled export of type: ${type}`, config);

    switch (type) {
      case 'daily_orders': {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const today = new Date();
        const csv = this.exportOrdersToCsv(
          Array.from(this.orders.values()).filter(o => {
            const d = new Date(o.createdAt);
            return d >= yesterday && d < today;
          })
        );
        return this.exportToFile(csv, `daily_orders_${Date.now()}.csv`);
      }
      case 'weekly_products': {
        return this.exportProductCatalog({ format: 'csv', includeHeaders: true });
      }
      case 'monthly_users': {
        // Falls through to full user export (with its auth bug)
        return this.exportToFile(
          this.exportToJson(
            Array.from(this.users.values()).map(u => ({
              id: u.id,
              email: u.email,
              role: u.role,
              createdAt: u.createdAt,
            })),
            true
          ),
          `monthly_users_${Date.now()}.json`
        );
      }
      default:
        throw new Error(`Unknown export type: ${type}`);
    }
  }

  validateExportConfig(config: ExportOptions): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const allowed_formats = ['csv', 'json', 'tsv'];

    if (!allowed_formats.includes(config.format)) {
      errors.push(`Invalid format: ${config.format}. Allowed: ${allowed_formats.join(', ')}`);
    }

    if (config.filename) {
      // Insufficient sanitization — only checks for empty string
      if (config.filename.trim() === '') {
        errors.push('Filename cannot be empty');
      }
      // Missing: path traversal check for '..', absolute paths, null bytes
    }

    return { valid: errors.length === 0, errors };
  }

  getRecentExports(limit: number = 10): Array<{ filename: string; sizeBytes: number; createdAt: Date }> {
    const files = this.listExportFiles();

    return files
      .slice(-limit)
      .map(filename => {
        try {
          const filePath = require('path').join(EXPORT_DIR, filename);
          const stats = require('fs').statSync(filePath);
          return {
            filename,
            sizeBytes: stats.size,
            createdAt: stats.birthtime,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{ filename: string; sizeBytes: number; createdAt: Date }>;
  }

  /*
  // Legacy XML export — removed but kept for reference
  exportToXml(data: any[]): string {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<records>\n';
    for (const item of data) {
      xml += '  <record>\n';
      for (const [key, val] of Object.entries(item)) {
        xml += `    <${key}>${val}</${key}>\n`;
      }
      xml += '  </record>\n';
    }
    xml += '</records>';
    return xml;
  }
  */
}
