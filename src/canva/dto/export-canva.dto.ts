import { IsNotEmpty, IsUrl, Matches } from 'class-validator';

export class ExportCanvaDto {
  @IsUrl({ require_protocol: true })
  @Matches(/^https:\/\/(?:(?:www\.)?canva\.com|canva\.link)\//, {
    message: 'url must be a public https://canva.com or https://canva.link link',
  })
  @IsNotEmpty()
  url!: string;
}
