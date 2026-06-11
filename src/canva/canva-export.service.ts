import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { createHash } from "crypto";
import { basename, extname, join } from "path";
import { pathToFileURL } from "url";
import { PDFDocument } from "pdf-lib";
import puppeteer from "puppeteer";
import puppeteerCore, {
  type Browser,
  type LaunchOptions,
  type Page,
} from "puppeteer-core";

export type ExportedPdf = {
  fileName: string;
  buffer: Buffer;
};

type RenderSize = {
  width: number;
  height: number;
};

type ServerlessChromium = {
  args: string[];
  executablePath: () => Promise<string>;
};

@Injectable()
export class CanvaExportService {
  private static exportQueue: Promise<void> = Promise.resolve();
  private static exportRequestTimestamps: number[] = [];

  private readonly logger = new Logger(CanvaExportService.name);
  private readonly timeoutMs = Number(
    process.env.CANVA_EXPORT_TIMEOUT_MS ?? 120_000,
  );
  private readonly maxExportsPerWindow = this.readPositiveIntegerEnv(
    "CANVA_EXPORT_RATE_LIMIT",
    10,
  );
  private readonly rateLimitWindowMs = this.readPositiveIntegerEnv(
    "CANVA_EXPORT_RATE_LIMIT_WINDOW_MS",
    60_000,
  );
  private readonly commonChromiumArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--window-size=1440,1000",
  ];

  async exportPublicDesign(url: string): Promise<ExportedPdf> {
    await this.assertPublicCanvaUrl(url);
    this.assertWithinRateLimit();

    return this.runExclusiveExport(async () => {
      let browser: Browser | undefined;

      try {
        browser = await this.launchBrowser();

        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 1000 });

        await page.goto(url, {
          waitUntil: "load",
          timeout: this.timeoutMs,
        });
        const [baseUrl, totalPageCount] =
          await this.assertResolvedCanvaUrl(page);
        const fileName = this.fileNameFromTitle(await page.title(), url);

        const buffer = await this.triggerPrintToPdf(
          page,
          baseUrl,
          totalPageCount,
        );

        return { fileName, buffer };
      } catch (error) {
        if (error instanceof HttpException) {
          throw error;
        }

        this.logger.error(error);
        throw new BadGatewayException(
          "Could not export this public Canva link to PDF",
        );
      } finally {
        await browser?.close();
      }
    });
  }

  private assertWithinRateLimit() {
    const now = Date.now();

    CanvaExportService.exportRequestTimestamps =
      CanvaExportService.exportRequestTimestamps.filter(
        (timestamp) => now - timestamp < this.rateLimitWindowMs,
      );

    if (
      CanvaExportService.exportRequestTimestamps.length >=
      this.maxExportsPerWindow
    ) {
      throw new HttpException(
        "Too many Canva export requests. Please retry later.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    CanvaExportService.exportRequestTimestamps.push(now);
  }

  private async runExclusiveExport<T>(task: () => Promise<T>): Promise<T> {
    const previousExport = CanvaExportService.exportQueue;
    let releaseCurrentExport!: () => void;

    CanvaExportService.exportQueue = new Promise((resolve) => {
      releaseCurrentExport = resolve;
    });

    await previousExport;

    try {
      return await task();
    } finally {
      releaseCurrentExport();
    }
  }

  private readPositiveIntegerEnv(name: string, fallback: number) {
    const rawValue = process.env[name];
    const value = rawValue ? Number(rawValue) : fallback;

    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private async launchBrowser() {
    const options: LaunchOptions = {
      // headless: false,
      headless: process.env.PUPPETEER_HEADLESS === "false" ? false : "shell",
      args: this.commonChromiumArgs,
    };
    const chromiumConfig = await this.resolveChromiumLaunchConfig();

    if (chromiumConfig.executablePath) {
      options.executablePath = chromiumConfig.executablePath;
      options.args = [
        ...(chromiumConfig.args ?? []),
        ...this.commonChromiumArgs,
      ];
      options.headless = true;
      return puppeteerCore.launch(options);
    }

    return puppeteer.launch(options);
  }

  private async resolveChromiumLaunchConfig(): Promise<{
    args?: string[];
    executablePath?: string;
  }> {
    const executablePath = process.env.PUPPETEER_CHROMIUM_EXECUTABLE_PATH;

    if (this.isServerlessRuntime()) {
      const serverlessChromium = await this.importServerlessChromium();

      return {
        args: serverlessChromium.args,
        executablePath:
          executablePath ?? (await serverlessChromium.executablePath()),
      };
    }

    if (executablePath) {
      return { executablePath };
    }

    return {};
  }

  private isServerlessRuntime() {
    return (
      process.env.VERCEL === "1" ||
      Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME)
    );
  }

  private async importServerlessChromium(): Promise<ServerlessChromium> {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<{ default: ServerlessChromium }>;
    const chromiumBridgeUrl = pathToFileURL(
      join(process.cwd(), "src/serverless-chromium.mjs"),
    ).href;
    const chromiumModule = await dynamicImport(chromiumBridgeUrl);

    return chromiumModule.default;
  }

  private async assertPublicCanvaUrl(url: string) {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== "https:") {
      throw new BadRequestException("Only HTTPS Canva links are supported");
    }

    if (
      !["canva.com", "www.canva.com", "canva.link"].includes(parsedUrl.hostname)
    ) {
      throw new BadRequestException(
        "Only canva.com and canva.link links are supported",
      );
    }
  }

  private async assertResolvedCanvaUrl(page: Page): Promise<[string, number]> {
    const parsedUrl = new URL(page.url());

    if (!["canva.com", "www.canva.com"].includes(parsedUrl.hostname)) {
      throw new BadRequestException(
        "Canva short link did not resolve to a public canva.com page",
      );
    }
    const sourceUrl = parsedUrl.origin + parsedUrl.pathname;
    if (!sourceUrl.endsWith("view")) {
      throw new BadRequestException("Canva video links are not supported");
    }
    const totalPageCount = await this.detectTotalPageCount(page);
    await page.goto(sourceUrl + `#${totalPageCount}`, {
      waitUntil: "networkidle2",
      timeout: this.timeoutMs,
    });
    await this.removeViewerChrome(page);

    return [sourceUrl, totalPageCount];
  }

  private async detectTotalPageCount(page: Page) {
    await page.waitForSelector(".QxuLlQ", {
      visible: true,
      timeout: this.timeoutMs,
    });

    const totalPageCount = await page.evaluate(() => {
      const pageCountValues = Array.from(
        document.querySelectorAll<HTMLElement>(".QxuLlQ"),
      )
        .map((element) => Number(element.textContent?.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);

      return pageCountValues[pageCountValues.length - 1] ?? 1;
    });

    return totalPageCount;
  }

  private async triggerPrintToPdf(
    page: Page,
    url: string,
    totalPageCount: number,
  ) {
    await page.emulateMediaType("screen");

    const outputPdf = await PDFDocument.create();
    for (let pageNumber = totalPageCount; pageNumber >= 1; pageNumber--) {
      await this.goToDesignPage(page, url, pageNumber);

      const size = await this.prepareContentOnlyPrint(page);
      const pagePdf = await page.pdf({
        printBackground: true,
        width: `${size.width}px`,
        height: `${size.height}px`,
        preferCSSPageSize: false,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      const inputPdf = await PDFDocument.load(pagePdf);
      const [inputPage] = await outputPdf.copyPages(inputPdf, [0]);

      outputPdf.insertPage(0, inputPage);
    }

    return Buffer.from(await outputPdf.save());
  }

  private async prepareContentOnlyPrint(page: Page): Promise<RenderSize> {
    const size = await this.detectRenderedDesignSize(page);
    await page.setViewport(size);

    await page.evaluate((targetSize) => {
      const browserGlobal = globalThis as typeof globalThis & Window;
      const document = browserGlobal.document;
      const contentRoot = findContentRoot();

      document.documentElement.style.width = `${targetSize.width}px`;
      document.documentElement.style.height = `${targetSize.height}px`;
      document.documentElement.style.margin = "0";
      document.documentElement.style.padding = "0";
      document.documentElement.style.overflow = "hidden";
      document.documentElement.style.background = "transparent";

      document.body.style.width = `${targetSize.width}px`;
      document.body.style.height = `${targetSize.height}px`;
      document.body.style.margin = "0";
      document.body.style.padding = "0";
      document.body.style.overflow = "hidden";
      document.body.style.background = "transparent";

      if (!contentRoot) {
        return;
      }

      contentRoot.style.position = "fixed";
      contentRoot.style.top = "0";
      contentRoot.style.left = "0";
      contentRoot.style.width = `${targetSize.width}px`;
      contentRoot.style.height = `${targetSize.height}px`;
      contentRoot.style.margin = "0";
      contentRoot.style.transform = "none";
      contentRoot.style.zIndex = "2147483647";

      for (const element of Array.from(document.body.children)) {
        if (element !== contentRoot && !element.contains(contentRoot)) {
          (element as HTMLElement).style.background = "transparent";
        }
      }

      function findContentRoot() {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>("._8jGYJw"),
        )
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const styleWidth = parseCssPx(element.style.width);
            const styleHeight = parseCssPx(element.style.height);
            const width = styleWidth || rect.width;
            const height = styleHeight || rect.height;

            return {
              element,
              width,
              height,
              area: width * height,
              visible:
                width >= 100 &&
                height >= 100 &&
                rect.bottom > 0 &&
                rect.right > 0 &&
                rect.top < browserGlobal.innerHeight &&
                rect.left < browserGlobal.innerWidth,
            };
          })
          .filter((candidate) => candidate.visible)
          .sort((a, b) => b.area - a.area);

        return candidates[0]?.element ?? null;
      }

      function parseCssPx(value: string) {
        const match = value.match(/^([\d.]+)px$/);
        return match ? Number(match[1]) : 0;
      }
    }, size);

    return size;
  }

  private async goToDesignPage(
    page: Page,
    sourceUrl: string,
    pageNumber: number,
  ) {
    await page.goto(sourceUrl + `#${pageNumber}`, {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs,
    });

    if (pageNumber === pageNumber) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  private async removeViewerChrome(page: Page) {
    await page.evaluate(() => {
      const browserGlobal = globalThis as typeof globalThis & Window;
      const selectors = ["header", "footer"];

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
        "._8jGYJw",
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
          const styleWidth = parseCssPx(element.style.width);
          const styleHeight = parseCssPx(element.style.height);
          const width = styleWidth || rect.width;
          const height = styleHeight || rect.height;

          return {
            width: Math.round(width),
            height: Math.round(height),
            area: Math.round(width * height),
            visible:
              width >= 100 &&
              height >= 100 &&
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

      function parseCssPx(value: string) {
        const match = value.match(/^([\d.]+)px$/);
        return match ? Number(match[1]) : 0;
      }
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

  private fileNameFromTitle(title: string, url: string) {
    const sanitizedTitle = title
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\.+$/g, "");
    const baseName = sanitizedTitle || this.slugFromUrl(url);

    return `${baseName}.pdf`;
  }
}
