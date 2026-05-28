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

Canva không có public API chính thức để export PDF trực tiếp từ một link public bất kỳ. Project này dùng Playwright để mở link public, detect tổng số trang, render từng trang bằng fragment `#1`, `#2`, ... rồi xóa viewer chrome trước khi tạo PDF theo kích thước vùng thiết kế đang render.

Vì UI Canva có thể thay đổi, bước đo kích thước render trong `src/canva/canva-export.service.ts` là nơi cần tinh chỉnh nếu PDF bị sai tỷ lệ hoặc crop.
