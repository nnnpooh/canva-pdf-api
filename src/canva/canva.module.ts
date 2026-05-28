import { Module } from '@nestjs/common';
import { CanvaController } from './canva.controller';
import { CanvaExportService } from './canva-export.service';

@Module({
  controllers: [CanvaController],
  providers: [CanvaExportService],
})
export class CanvaModule {}
