import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express, { type Express, type Request, type Response } from 'express';
import { AppModule } from '../src/app.module';

let cachedApp: Express | undefined;

async function bootstrapServer() {
  if (cachedApp) {
    return cachedApp;
  }

  const server = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    logger: ['error', 'warn', 'log'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  await app.init();
  cachedApp = server;

  return server;
}

export default async function handler(request: Request, response: Response) {
  const server = await bootstrapServer();

  return server(request, response);
}
