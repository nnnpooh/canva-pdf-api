import { Module } from '@nestjs/common';
import { CanvaModule } from './canva/canva.module';

@Module({
  imports: [CanvaModule],
})
export class AppModule {}
