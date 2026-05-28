import {
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
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
  async exportPdf(@Body() dto: ExportCanvaDto) {
    const result = await this.canvaExportService.exportPublicDesign(dto.url);

    return {
      id: result.id,
      fileName: result.fileName,
      downloadUrl: `/canva/download/${result.id}`,
    };
  }

  @Get('download/:id')
  @Header('Content-Type', 'application/pdf')
  async downloadPdf(@Param('id') id: string, @Res() response: Response) {
    const file = await this.canvaExportService.getExportedFile(id);

    if (!file) {
      throw new NotFoundException('PDF export not found');
    }

    response.download(file.path, file.fileName);
  }
}
