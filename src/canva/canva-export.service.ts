import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { mkdir, stat, writeFile } from "fs/promises";
import { basename, extname, join, resolve } from "path";
import { PDFDocument } from "pdf-lib";
import { chromium, type Browser, type Page } from "playwright";

type ExportedFile = {
  id: string;
  fileName: string;
  path: string;
};

type RenderSize = {
  width: number;
  height: number;
};

@Injectable()
export class CanvaExportService {
  private readonly logger = new Logger(CanvaExportService.name);
  private readonly downloadDir = resolve(
    process.env.DOWNLOAD_DIR ?? "storage/downloads",
  );
  private readonly timeoutMs = Number(
    process.env.CANVA_EXPORT_TIMEOUT_MS ?? 120_000,
  );

  async exportPublicDesign(url: string): Promise<ExportedFile> {
    await this.assertPublicCanvaUrl(url);
    await mkdir(this.downloadDir, { recursive: true });

    const id = randomUUID();
    const fileName = `${this.slugFromUrl(url)}-${id}.pdf`;
    const targetPath = join(this.downloadDir, fileName);

    let browser: Browser | undefined;

    try {
      browser = await chromium.launch({
        headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
      });

      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      this.assertResolvedCanvaUrl(page.url());

      await this.dismissCookieBanner(page);
      await this.triggerPrintToPdf(page, targetPath);

      return { id, fileName, path: targetPath };
    } catch (error) {
      this.logger.error(error);
      throw new BadGatewayException(
        "Could not export this public Canva link to PDF",
      );
    } finally {
      await browser?.close();
    }
  }

  async getExportedFile(id: string): Promise<ExportedFile | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return null;
    }

    const files = await this.findDownloadById(id);
    if (!files) {
      return null;
    }

    return files;
  }

  private async assertPublicCanvaUrl(url: string) {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== "https:") {
      throw new BadRequestException("Only HTTPS Canva links are supported");
    }

    if (
      !["canva.com", "www.canva.com", "canva.link"].includes(
        parsedUrl.hostname,
      )
    ) {
      throw new BadRequestException(
        "Only canva.com and canva.link links are supported",
      );
    }
  }

  private assertResolvedCanvaUrl(url: string) {
    const parsedUrl = new URL(url);

    if (!["canva.com", "www.canva.com"].includes(parsedUrl.hostname)) {
      throw new BadRequestException(
        "Canva short link did not resolve to a public canva.com page",
      );
    }
  }

  private async triggerPrintToPdf(page: Page, targetPath: string) {
    await page.waitForLoadState("networkidle", { timeout: this.timeoutMs });
    await page.emulateMedia({ media: "screen" });

    const sourceUrl = page.url();
    const pageCount = await this.detectPageCount(page);
    const outputPdf = await PDFDocument.create();

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      await this.goToDesignPage(page, sourceUrl, pageNumber);
      await this.removeViewerChrome(page);

      const size = await this.detectRenderedDesignSize(page);
      const pagePdf = await page.pdf({
        printBackground: true,
        width: `${size.width}px`,
        height: `${size.height}px`,
        preferCSSPageSize: false,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      const inputPdf = await PDFDocument.load(pagePdf);
      const [inputPage] = await outputPdf.copyPages(inputPdf, [0]);

      outputPdf.addPage(inputPage);
    }

    await writeFile(targetPath, await outputPdf.save());

    return targetPath;
  }

  private async detectPageCount(page: Page) {
    const pageCount = await page.evaluate(() => {
      const browserGlobal = globalThis as typeof globalThis & Window;
      const slider = browserGlobal.document.querySelector<HTMLElement>(
        '[aria-label="Thanh trượt thiết kế"][aria-valuemax], [role="slider"][aria-valuemax]',
      );
      const max = slider?.getAttribute("aria-valuemax");

      if (max) {
        const parsedMax = Number(max);
        if (Number.isInteger(parsedMax) && parsedMax > 0) {
          return parsedMax;
        }
      }

      const pageAccessButton = Array.from(
        browserGlobal.document.querySelectorAll("button"),
      ).find((button) => /truy cập trang|go to page/i.test(button.ariaLabel ?? ""));
      const text = pageAccessButton?.textContent ?? "";
      const totalFromText = text.match(/\/\s*(\d+)/)?.[1];

      return totalFromText ? Number(totalFromText) : 1;
    });

    return Number.isInteger(pageCount) && pageCount > 0 ? pageCount : 1;
  }

  private async goToDesignPage(page: Page, sourceUrl: string, pageNumber: number) {
    const pageUrl = this.withPageHash(sourceUrl, pageNumber);

    if (page.url() !== pageUrl) {
      await page.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
    }

    await page.waitForLoadState("networkidle", { timeout: this.timeoutMs });
    await page.waitForTimeout(500);
  }

  private withPageHash(url: string, pageNumber: number) {
    const parsedUrl = new URL(url);
    parsedUrl.hash = String(pageNumber);

    return parsedUrl.toString();
  }

  private async removeViewerChrome(page: Page) {
    await page.evaluate(() => {
      const browserGlobal = globalThis as typeof globalThis & Window;
      const selectors = [
        "header",
        "footer",
        '[aria-labelledby="viewerFooterLabel"]',
        '[role="toolbar"]',
        '[role="dialog"]',
        '[role="menu"]',
        '[role="tooltip"]',
        '[aria-label="Chia sẻ"]',
        '[aria-label="Trượt"]',
        '[aria-label="Phóng to và thu nhỏ"]',
        '[aria-label="Xem thêm"]',
        '[aria-label="Mở chế độ toàn màn hình"]',
        '[aria-label="Trang trước đó"]',
        '[aria-label="Trang tiếp theo"]',
        '[aria-label="Truy cập trang"]',
      ];

      for (const selector of selectors) {
        for (const element of Array.from(
          browserGlobal.document.querySelectorAll(selector),
        )) {
          element.remove();
        }
      }
    });
  }

  private async detectRenderedDesignSize(page: Page): Promise<RenderSize> {
    const size = await page.evaluate(() => {
      const browserGlobal = globalThis as typeof globalThis & Window;
      const viewportWidth = browserGlobal.innerWidth;
      const viewportHeight = browserGlobal.innerHeight;
      const selectors = [
        "canvas",
        "svg",
        "img",
        '[role="img"]',
        '[data-testid*="page" i]',
        '[data-testid*="canvas" i]',
        '[class*="page" i]',
        '[class*="canvas" i]',
      ];
      const elements = selectors.flatMap((selector) =>
        Array.from(
          browserGlobal.document.querySelectorAll<HTMLElement>(selector),
        ),
      );

      const candidates = elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            area: Math.round(rect.width * rect.height),
            visible:
              rect.width >= 100 &&
              rect.height >= 100 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < viewportHeight &&
              rect.left < viewportWidth,
          };
        })
        .filter((candidate) => candidate.visible)
        .sort((a, b) => b.area - a.area);

      const largest = candidates[0];

      if (largest) {
        return {
          width: largest.width,
          height: largest.height,
        };
      }

      return {
        width: viewportWidth,
        height: viewportHeight,
      };
    });

    return this.normalizePdfSize(size);
  }

  private normalizePdfSize(size: RenderSize): RenderSize {
    const minSize = 320;
    const maxSize = 2400;
    const width = Math.max(minSize, Math.min(maxSize, Math.round(size.width)));
    const height = Math.max(
      minSize,
      Math.min(maxSize, Math.round(size.height)),
    );

    return { width, height };
  }

  private async dismissCookieBanner(page: Page) {
    for (const selector of [
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("I agree")',
    ]) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
        await locator.click();
        return;
      }
    }
  }

  private async findDownloadById(id: string): Promise<ExportedFile | null> {
    await mkdir(this.downloadDir, { recursive: true });

    const prefix = `${id}.pdf`;
    const directPath = join(this.downloadDir, prefix);

    if (await this.fileExists(directPath)) {
      return { id, fileName: prefix, path: directPath };
    }

    const { readdir } = await import("fs/promises");
    const fileName = (await readdir(this.downloadDir)).find((file) =>
      file.endsWith(`${id}.pdf`),
    );

    return fileName
      ? { id, fileName, path: join(this.downloadDir, fileName) }
      : null;
  }

  private async fileExists(path: string) {
    return stat(path)
      .then(() => true)
      .catch(() => false);
  }

  private slugFromUrl(url: string) {
    const parsedUrl = new URL(url);
    const lastPathPart = basename(parsedUrl.pathname).replace(
      extname(parsedUrl.pathname),
      "",
    );

    if (lastPathPart) {
      return lastPathPart.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    }

    return createHash("sha1").update(url).digest("hex").slice(0, 10);
  }
}
