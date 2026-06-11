import {
  Body,
  Controller,
  Get,
  Header,
  Logger,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { get, list, put } from "@vercel/blob";
import { waitUntil } from "@vercel/functions";
import { createHash } from "crypto";
import type { Response } from "express";
import {
  CanvaExportService,
  type ExportedPdf,
} from "./canva-export.service";
import { ExportCanvaDto } from "./dto/export-canva.dto";

@Controller("canva")
export class CanvaController {
  private readonly logger = new Logger(CanvaController.name);
  private readonly cacheTtlMs = this.readPositiveIntegerEnv(
    "CANVA_EXPORT_GET_CACHE_TTL_MS",
    10 * 60 * 1000,
  );
  private readonly isGetCacheEnabled = this.readBooleanEnv(
    "CANVA_EXPORT_GET_CACHE_ENABLED",
    true,
  );
  private readonly blobCacheAccess =
    process.env.CANVA_EXPORT_BLOB_CACHE_ACCESS === "public"
      ? "public"
      : "private";

  constructor(private readonly canvaExportService: CanvaExportService) {}

  @Post("export")
  @Header("Content-Type", "application/pdf")
  async exportPdf(@Body() dto: ExportCanvaDto, @Res() response: Response) {
    const result = await this.canvaExportService.exportPublicDesign(dto.url);

    this.sendPdfResponse(response, result);
  }

  @Get("export")
  @Header("Content-Type", "application/pdf")
  async exportPdfByQuery(
    @Query() dto: ExportCanvaDto,
    @Res() response: Response,
  ) {
    const cachedResult = await this.getBlobCachedExport(dto.url);

    if (cachedResult) {
      this.sendPdfResponse(response, cachedResult, "HIT");
      return;
    }

    const result = await this.canvaExportService.exportPublicDesign(dto.url);
    const cacheStatus = this.queueBlobCachedExport(dto.url, result);

    this.sendPdfResponse(response, result, cacheStatus);
  }

  private sendPdfResponse(
    response: Response,
    result: ExportedPdf,
    cacheStatus?: "HIT" | "MISS" | "BYPASS",
  ) {
    response.setHeader(
      "Content-Disposition",
      `inline; filename="${result.fileName}"`,
    );
    response.setHeader("Content-Length", result.buffer.length);

    if (cacheStatus) {
      response.setHeader("X-Cache", cacheStatus);
      response.setHeader(
        "Cache-Control",
        `private, max-age=${Math.floor(this.cacheTtlMs / 1000)}`,
      );
    }

    response.send(result.buffer);
  }

  private async getBlobCachedExport(url: string): Promise<ExportedPdf | null> {
    if (!this.isBlobCacheEnabled()) {
      return null;
    }

    const cachedBlob = await this.findBlobCachedExport(url);

    if (!cachedBlob) {
      return null;
    }

    try {
      const blob = await get(cachedBlob.pathname, {
        ...this.blobCommandOptions(),
        access: this.blobCacheAccess,
      });

      if (!blob || blob.statusCode !== 200) {
        return null;
      }

      const arrayBuffer = await new Response(blob.stream).arrayBuffer();

      return {
        fileName: this.fileNameFromBlobPathname(cachedBlob.pathname),
        buffer: Buffer.from(arrayBuffer),
      };
    } catch (error) {
      this.logger.warn(`Could not read Canva export from Blob cache: ${error}`);
      return null;
    }
  }

  private queueBlobCachedExport(
    url: string,
    result: ExportedPdf,
  ): "MISS" | "BYPASS" {
    if (!this.isBlobCacheEnabled()) {
      return "BYPASS";
    }

    const writePromise = this.setBlobCachedExport(url, result);
    const scheduled = waitUntil(writePromise);

    if (scheduled === undefined) {
      void writePromise;
    }

    return "MISS";
  }

  private async setBlobCachedExport(url: string, result: ExportedPdf) {
    try {
      await put(this.blobCachePathname(url, result.fileName), result.buffer, {
        ...this.blobCommandOptions(),
        access: this.blobCacheAccess,
        allowOverwrite: true,
        cacheControlMaxAge: Math.max(60, Math.floor(this.cacheTtlMs / 1000)),
        contentType: "application/pdf",
        multipart: true,
      });
    } catch (error) {
      this.logger.warn(`Could not write Canva export to Blob cache: ${error}`);
    }
  }

  private isBlobCacheEnabled() {
    return this.isGetCacheEnabled && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  }

  private blobCommandOptions() {
    return {
      storeId: process.env.BLOB_STORE_ID,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    };
  }

  private async findBlobCachedExport(url: string) {
    try {
      const result = await list({
        ...this.blobCommandOptions(),
        limit: 1,
        prefix: this.blobCachePrefix(url),
      });
      const cachedBlob = result.blobs[0];

      if (!cachedBlob) {
        return null;
      }

      const ageMs = Date.now() - cachedBlob.uploadedAt.getTime();

      return ageMs > this.cacheTtlMs ? null : cachedBlob;
    } catch (error) {
      this.logger.warn(`Could not list Canva export Blob cache: ${error}`);
      return null;
    }
  }

  private blobCachePathname(url: string, fileName: string) {
    return `${this.blobCachePrefix(url)}${fileName}`;
  }

  private blobCachePrefix(url: string) {
    const cacheKey = createHash("sha256").update(url).digest("hex");

    return `canva-export-cache/${cacheKey}/`;
  }

  private fileNameFromBlobPathname(pathname: string) {
    return pathname.split("/").pop() ?? "canva-export.pdf";
  }

  private readPositiveIntegerEnv(name: string, fallback: number) {
    const rawValue = process.env[name];
    const value = rawValue ? Number(rawValue) : fallback;

    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private readBooleanEnv(name: string, fallback: boolean) {
    const rawValue = process.env[name];

    if (!rawValue) {
      return fallback;
    }

    return !["0", "false", "off"].includes(rawValue.toLowerCase());
  }
}
