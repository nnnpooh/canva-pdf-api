# Canva PDF API

NestJS API nhận Canva public link và tạo file PDF tải xuống.

## Cài đặt

```bash
npm install
npm run install:browsers
cp .env.example .env
npm run start:dev
```

## API

### Export Canva public link

```bash
curl -X POST http://localhost:5001/canva/export \
  -H "Content-Type: application/json" \
  -d '{"url":"https://canva.link/rf6rzlnni2fpmuk"}' \
  -o canva.pdf
```

Response là file PDF trực tiếp với header `Content-Disposition: attachment`.

## Lưu ý

Canva không có public API chính thức để export PDF trực tiếp từ một link public bất kỳ. Project này dùng Puppeteer để mở link public, detect tổng số trang, render từng trang bằng fragment `#1`, `#2`, ... rồi xóa viewer chrome trước khi tạo PDF theo kích thước vùng thiết kế đang render.

Vì UI Canva có thể thay đổi, bước đo kích thước render trong `src/canva/canva-export.service.ts` là nơi cần tinh chỉnh nếu PDF bị sai tỷ lệ hoặc crop.

## Deploy Vercel

Trên Vercel không cần chạy `npm run install:browsers`. Runtime serverless dùng Chromium từ `@sparticuz/chromium`; local vẫn dùng browser cài bằng `npm run install:browsers`.

Nếu muốn trỏ tới browser tự cung cấp, set env:

```bash
PUPPETEER_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium
```

Giới hạn tải PDF:

```bash
CANVA_EXPORT_RATE_LIMIT=10
CANVA_EXPORT_RATE_LIMIT_WINDOW_MS=60000
```

API xếp hàng và chỉ xử lý 1 file tại một thời điểm trên mỗi server instance, đồng thời nhận tối đa 10 lượt export mỗi 60 giây theo cấu hình trên.
