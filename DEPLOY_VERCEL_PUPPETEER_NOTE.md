# NestJS + Puppeteer on Vercel (Practical Note)

## Mục tiêu

Chạy API NestJS có crawler Puppeteer trên Vercel Serverless Function mà không crash.

## Vấn đề cốt lõi

- `puppeteer` mặc định cần Chromium local, thường không tương thích serverless runtime.
- `@vendia/serverless-express` nhận event kiểu AWS Lambda, không phù hợp Vercel `req/res` nếu dùng sai cách.

## Cách làm đã chạy ổn

### 1. Dùng Chromium dành cho serverless khi chạy trên Vercel

Trong service:

- Local: dùng `puppeteer` như bình thường.
- Vercel: dùng `puppeteer-core` + `@sparticuz/chromium`.

Ý tưởng:

- Kiểm tra `process.env.VERCEL`.
- Nếu true: dynamic import `@sparticuz/chromium` và `puppeteer-core`, launch bằng `executablePath` từ chromium package.
- Nếu false: launch bằng `puppeteer` local.

File tham chiếu: `src/app.service.ts`

### 2. Dùng handler native Vercel

Không dùng `@vendia/serverless-express` ở project này.

Dùng `api/index.ts`:

- Tạo Express app.
- Gắn Nest bằng `ExpressAdapter`.
- `await nestApp.init()`.
- Cache app trong biến `cachedApp` để giảm cold-start overhead.
- Export default function `(req, res) => cachedApp(req, res)`.

File tham chiếu: `api/index.ts`

### 3. Cấu hình route về 1 function

`vercel.json`:

- Route mọi request về `api/index.ts`.
- Tăng `memory` và `maxDuration` cho crawler.

File tham chiếu: `vercel.json`

### 4. Fix crash pattern quan trọng

Trong crawler:

- Không phụ thuộc `browser.pages()` cho page đầu tiên.
- Dùng `const page = await browser.newPage()`.
- Bọc `try/catch/finally` và luôn `await browser.close()` trong `finally`.

## Dependencies cần có

Trong `dependencies`:

- `puppeteer`
- `puppeteer-core`
- `@sparticuz/chromium`
- `express`
- `@nestjs/platform-express`

Không cần `@vendia/serverless-express` trong cách triển khai hiện tại.

## Lỗi đã gặp và cách nhận diện

### Lỗi 1

`This Serverless Function has crashed.`

- Thường do runtime error trong handler hoặc launch browser fail.
- Xử lý: bọc `try/catch` ở `api/index.ts` và log lỗi rõ ràng.

### Lỗi 2

`Unable to determine event source based on event.`

- Nguyên nhân: dùng adapter AWS-style (`serverless-express`) với event Vercel.
- Xử lý: đổi sang handler native `req/res`.

## Checklist cho lần sau

1. Tạo `api/index.ts` theo mô hình cache app + `ExpressAdapter`.
2. Thêm `vercel.json` route tất cả về `api/index.ts`.
3. Viết helper `launchBrowser()` tách local/Vercel.
4. Đảm bảo crawler dùng `newPage()` + `finally close`.
5. `npm run build` phải pass trước khi deploy.
6. Deploy: `vercel --prod`.
7. Test endpoint: `/api/v1/crawler`.
8. Nếu lỗi: `vercel logs <deployment-url> --since 1h`.

## Lệnh deploy nhanh

```bash
vercel --prod
```

## Endpoint mẫu

```text
https://<your-domain>/api/v1/crawler
```
