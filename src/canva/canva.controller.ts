import {
  Body,
  Controller,
  Header,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CanvaExportService } from './canva-export.service';
import { ExportCanvaDto } from './dto/export-canva.dto';

@Controller('canva')
export class CanvaController {
  constructor(private readonly canvaExportService: CanvaExportService) {}

  @Post('export')
  @Header('Content-Type', 'application/pdf')
  async exportPdf(@Body() dto: ExportCanvaDto, @Res() response: Response) {
    const result = await this.canvaExportService.exportPublicDesign(dto.url);

    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.fileName}"`,
    );
    response.setHeader('Content-Length', result.buffer.length);
    response.send(result.buffer);
  }
}
